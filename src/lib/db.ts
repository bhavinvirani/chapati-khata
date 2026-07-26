import { supabase } from "./supabase";
import { round2 } from "./util";
import { DEFAULT_PRICE } from "../config";
import { sharesAmount } from "./split";
import type { ShareInput } from "./split";
import type { Entry, LogAction, LogRow, User, Week } from "../types";

// This module owns every read/write. The rest of the app never talks to
// Supabase directly — swap this one file to change backends.

function fail(context: string, error: unknown): never {
  console.error(`[db] ${context}`, error);
  throw error;
}

async function logAction(row: {
  actor: string;
  action: LogAction;
  week_start?: string | null;
  day?: string | null;
  qty_before?: number | null;
  qty_after?: number | null;
  note_before?: string | null;
  note_after?: string | null;
  target?: string | null;
  device_id?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("logs").insert({
    actor: row.actor,
    action: row.action,
    week_start: row.week_start ?? null,
    day: row.day ?? null,
    qty_before: row.qty_before ?? null,
    qty_after: row.qty_after ?? null,
    note_before: row.note_before ?? null,
    note_after: row.note_after ?? null,
    target: row.target ?? null,
    device_id: row.device_id ?? null,
  });
  if (error) fail("logAction", error);
}

// ── reads ──
export const LOG_PAGE = 20;

// Shares travel with their entry — one round trip, and `needsRepair` can spot
// an entry that lost them without a second query.
const SELECT_ENTRY = "*, entry_shares(*)";

/** Fetch all weeks and users (both tiny), unpaid entries, first page of logs. */
export async function loadActive(): Promise<{
  weeks: Week[];
  entries: Entry[];
  users: User[];
  logs: LogRow[];
}> {
  // Independent queries — run them together.
  const [w, l, users] = await Promise.all([
    supabase.from("weeks").select("*"),
    supabase.from("logs").select("*").order("ts", { ascending: false }).limit(LOG_PAGE),
    loadUsers(),
  ]);
  if (w.error) fail("load weeks", w.error);
  if (l.error) fail("load logs", l.error);
  const weeks = (w.data ?? []) as Week[];

  // Entries depend on weeks result — fetch only for unpaid weeks.
  const unpaidIds = weeks.filter((wk) => !wk.paid).map((wk) => wk.week_start);
  let entries: Entry[] = [];
  if (unpaidIds.length > 0) {
    const e = await supabase.from("entries").select(SELECT_ENTRY).in("week_start", unpaidIds);
    if (e.error) fail("load entries", e.error);
    entries = (e.data ?? []) as Entry[];
  }

  return { weeks, entries, users, logs: (l.data ?? []) as LogRow[] };
}

/** Fetch entries for paid weeks (called on demand when history is expanded). */
export async function loadPaidEntries(paidWeekIds: string[]): Promise<Entry[]> {
  if (paidWeekIds.length === 0) return [];
  const { data, error } = await supabase
    .from("entries")
    .select(SELECT_ENTRY)
    .in("week_start", paidWeekIds);
  if (error) fail("loadPaidEntries", error);
  return (data ?? []) as Entry[];
}

/** Load older logs using composite cursor (ts + id) to handle duplicate timestamps. */
export async function loadMoreLogs(beforeTs: string, beforeId: string): Promise<LogRow[]> {
  const { data, error } = await supabase
    .from("logs")
    .select("*")
    .or(`ts.lt.${beforeTs},and(ts.eq.${beforeTs},id.lt.${beforeId})`)
    .order("ts", { ascending: false })
    .order("id", { ascending: false })
    .limit(LOG_PAGE);
  if (error) fail("loadMoreLogs", error);
  return (data ?? []) as LogRow[];
}

// ── writes ──

/** Validate name + code via Supabase Edge Function (production). */
export async function validateAccess(
  name: string,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("validate-access", {
    body: { name, code },
  });
  if (error) throw error;
  return data as { ok: boolean; error?: string };
}

/** Everyone on the list — the split composer and People sheet both need it. */
export async function loadUsers(): Promise<User[]> {
  const { data, error } = await supabase.from("users").select("*").order("created_at");
  if (error) fail("loadUsers", error);
  return (data ?? []) as User[];
}

/** Local-dev gate check. Production goes through the edge function instead. */
export async function nameCanLogin(name: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("name", name)
    .eq("can_login", true)
    .limit(1);
  if (error) fail("nameCanLogin", error);
  return (data ?? []).length > 0;
}

/** Record that a user signed in. */
export async function logLogin(actor: string, deviceId: string): Promise<void> {
  await logAction({ actor, action: "login", device_id: deviceId });
}

/** Ensure a week row exists without disturbing its paid state. */
async function ensureWeek(weekId: string): Promise<void> {
  const { error } = await supabase
    .from("weeks")
    .upsert({ week_start: weekId }, { onConflict: "week_start", ignoreDuplicates: true });
  if (error) fail("ensureWeek", error);
}

export interface EntryInput {
  qty: number;
  rate: number;
  note: string;
  shares: ShareInput[];
}

/**
 * Record one add: a purchase run with its own rate and its own full allocation.
 *
 * Not transactional \u2014 supabase-js has no client-side transactions. Shares go in
 * as a single batch statement, so Postgres commits all of them or none, which
 * leaves exactly one reachable bad state: an entry with no shares. If that
 * happens we try to undo the entry; if the undo also fails, `needsRepair` in
 * aggregate.ts catches the orphan and the UI offers to finish or discard it.
 */
export async function addEntry(
  weekId: string,
  day: string,
  input: EntryInput,
  actor: string,
  deviceId: string,
): Promise<void> {
  await ensureWeek(weekId);

  const { data, error } = await supabase
    .from("entries")
    .insert({
      week_start: weekId,
      day,
      qty: input.qty,
      rate: input.rate,
      amount: sharesAmount(input.shares),
      note: input.note,
    })
    .select("id")
    .single();
  if (error) fail("addEntry/insert", error);

  const entryId = (data as { id: string }).id;
  const { error: shareErr } = await supabase
    .from("entry_shares")
    .insert(input.shares.map((s) => ({ ...s, entry_id: entryId })));
  if (shareErr) {
    // Best effort: undo the entry rather than leave it unallocated.
    await supabase.from("entries").delete().eq("id", entryId);
    fail("addEntry/shares", shareErr);
  }

  await logAction({
    actor,
    action: "create",
    week_start: weekId,
    day,
    qty_after: input.qty,
    device_id: deviceId,
  });
}

/** Set an exact quantity, preserving the day's effective (blended) price. */
export async function editEntry(
  entry: Entry,
  newQty: number,
  newNote: string,
  actor: string,
  deviceId: string,
): Promise<void> {
  const eff = entry.qty ? entry.amount / entry.qty : DEFAULT_PRICE;
  const amount = round2(newQty * eff);
  const { error } = await supabase
    .from("entries")
    .update({ qty: newQty, amount, note: newNote })
    .eq("id", entry.id);
  if (error) fail("editEntry", error);
  const noteChanged = entry.note !== newNote;
  await logAction({
    actor,
    action: "edit",
    week_start: entry.week_start,
    day: entry.day,
    qty_before: entry.qty,
    qty_after: newQty,
    note_before: noteChanged ? entry.note : null,
    note_after: noteChanged ? newNote : null,
    device_id: deviceId,
  });
}

export async function deleteEntry(entry: Entry, actor: string, deviceId: string): Promise<void> {
  const { error } = await supabase.from("entries").delete().eq("id", entry.id);
  if (error) fail("deleteEntry", error);
  await logAction({
    actor,
    action: "delete",
    week_start: entry.week_start,
    day: entry.day,
    qty_before: entry.qty,
    device_id: deviceId,
  });
}

export async function setPaid(
  weekId: string,
  paid: boolean,
  actor: string,
  deviceId: string,
): Promise<void> {
  await ensureWeek(weekId);
  const { error } = await supabase
    .from("weeks")
    .update({ paid, paid_at: paid ? new Date().toISOString() : null })
    .eq("week_start", weekId);
  if (error) fail("setPaid", error);
  await logAction({
    actor,
    action: paid ? "paid" : "reopen",
    week_start: weekId,
    device_id: deviceId,
  });
}

export async function settleAll(weekIds: string[], actor: string, deviceId: string): Promise<void> {
  for (const weekId of weekIds) {
    await setPaid(weekId, true, actor, deviceId);
  }
}

// ── realtime ──
/** Fire `onChange` whenever any of the watched tables changes. Returns cleanup. */
export function subscribeChanges(onChange: () => void): () => void {
  const channel = supabase
    .channel("khata-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "weeks" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "entries" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "logs" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "entry_shares" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "users" }, onChange)
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
