import { supabase } from "./supabase";
import { sharesAmount } from "./split";
import type { ShareInput } from "./split";
import type { SplitwisePerson } from "./splitwise";
import type { PushKeys } from "./push";
import type { Entry, LogAction, LogRow, Settlement, User, Week } from "../types";
import { cap, money, normalizeName } from "./util";
import { SPLITWISE_CATEGORY_NAME, SPLITWISE_CURRENCY } from "../config";

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
  detail?: string | null;
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
    detail: row.detail ?? null,
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
  settlements: Settlement[];
}> {
  // Independent queries — run them together.
  const [w, l, users, s] = await Promise.all([
    supabase.from("weeks").select("*"),
    supabase.from("logs").select("*").order("ts", { ascending: false }).limit(LOG_PAGE),
    loadUsers(),
    supabase.from("settlements").select("*"),
  ]);
  if (w.error) fail("load weeks", w.error);
  if (l.error) fail("load logs", l.error);
  if (s.error) fail("load settlements", s.error);
  const weeks = (w.data ?? []) as Week[];

  // Entries depend on weeks result — fetch only for unpaid weeks.
  const unpaidIds = weeks.filter((wk) => !wk.paid).map((wk) => wk.week_start);
  let entries: Entry[] = [];
  if (unpaidIds.length > 0) {
    const e = await supabase.from("entries").select(SELECT_ENTRY).in("week_start", unpaidIds);
    if (e.error) fail("load entries", e.error);
    entries = (e.data ?? []) as Entry[];
  }

  return {
    weeks,
    entries,
    users,
    logs: (l.data ?? []) as LogRow[],
    settlements: (s.data ?? []) as Settlement[],
  };
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
  /** Guests. Counted in `qty`, but with no share row of its own. */
  otherQty: number;
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
  detail: string,
): Promise<void> {
  await ensureWeek(weekId);

  const { data, error } = await supabase
    .from("entries")
    .insert({
      week_start: weekId,
      day,
      qty: input.qty,
      rate: input.rate,
      other_qty: input.otherQty,
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
    detail,
    device_id: deviceId,
  });
}

/**
 * Replace an add's total, rate, note and allocation.
 *
 * Ordering rule: never delete existing shares before their replacements are
 * written. No ordering avoids a transient mismatch without a transaction, but
 * this one makes the transient state an over-allocation — visible and
 * repairable — rather than a loss of attribution.
 */
export async function editEntry(
  entry: Entry,
  input: EntryInput,
  actor: string,
  deviceId: string,
  detail: string,
): Promise<void> {
  const { error: upErr } = await supabase.from("entry_shares").upsert(
    input.shares.map((s) => ({ ...s, entry_id: entry.id })),
    {
      onConflict: "entry_id,user_id",
    },
  );
  if (upErr) fail("editEntry/shares", upErr);

  // Prune anyone dropped from the allocation. `keep` is never empty in practice
  // — the editor blocks saving a total of zero — but an empty `in ()` list is
  // invalid PostgREST, so branch rather than emit one.
  const keep = input.shares.map((s) => s.user_id);
  const prune = supabase.from("entry_shares").delete().eq("entry_id", entry.id);
  const { error: delErr } = await (keep.length > 0
    ? prune.not("user_id", "in", `(${keep.join(",")})`)
    : prune);
  if (delErr) fail("editEntry/prune", delErr);

  const { error } = await supabase
    .from("entries")
    .update({
      qty: input.qty,
      rate: input.rate,
      other_qty: input.otherQty,
      amount: sharesAmount(input.shares),
      note: input.note,
    })
    .eq("id", entry.id);
  if (error) fail("editEntry", error);

  const noteChanged = entry.note !== input.note;
  await logAction({
    actor,
    action: "edit",
    week_start: entry.week_start,
    day: entry.day,
    qty_before: entry.qty,
    qty_after: input.qty,
    note_before: noteChanged ? entry.note : null,
    note_after: noteChanged ? input.note : null,
    detail,
    device_id: deviceId,
  });
}

export async function deleteEntry(
  entry: Entry,
  actor: string,
  deviceId: string,
  detail: string,
): Promise<void> {
  const { error } = await supabase.from("entries").delete().eq("id", entry.id);
  if (error) fail("deleteEntry", error);
  await logAction({
    actor,
    action: "delete",
    week_start: entry.week_start,
    day: entry.day,
    qty_before: entry.qty,
    detail,
    device_id: deviceId,
  });
}

/**
 * Pay one or more weeks in a single settlement — the pushable unit for the
 * Splitwise integration (§4.5/§7.2 of the design). A single-week Mark Paid
 * is `createSettlement([weekId], ...)`; Settle All passes every open week.
 */
export async function createSettlement(
  weekIds: string[],
  actor: string,
  deviceId: string,
): Promise<void> {
  for (const weekId of weekIds) {
    await ensureWeek(weekId);
  }

  const { data, error } = await supabase
    .from("settlements")
    .insert({ actor, device_id: deviceId })
    .select("id, created_at")
    .single();
  if (error) fail("createSettlement/insert", error);
  const { id: settlementId, created_at } = data as { id: string; created_at: string };

  const { error: upErr } = await supabase
    .from("weeks")
    .update({ paid: true, paid_at: created_at, settlement_id: settlementId })
    .in("week_start", weekIds);
  if (upErr) fail("createSettlement/weeks", upErr);

  for (const weekId of weekIds) {
    await logAction({ actor, action: "paid", week_start: weekId, device_id: deviceId });
  }
}

/**
 * Reopen a week. If it belongs to a settlement, every week in that
 * settlement reopens together (§4.6) — a settlement is one payment event,
 * not divisible per week. A week paid before this feature shipped has no
 * settlement (`settlement_id` is null) and just reopens alone, exactly as
 * it always did.
 */
export async function reopenWeek(week: Week, actor: string, deviceId: string): Promise<void> {
  if (!week.settlement_id) {
    const { error } = await supabase
      .from("weeks")
      .update({ paid: false, paid_at: null })
      .eq("week_start", week.week_start);
    if (error) fail("reopenWeek", error);
    await logAction({ actor, action: "reopen", week_start: week.week_start, device_id: deviceId });
    return;
  }

  const { data: settlementRow, error: settlementErr } = await supabase
    .from("settlements")
    .select("splitwise_expense_id")
    .eq("id", week.settlement_id)
    .single();
  if (settlementErr) fail("reopenWeek/settlement", settlementErr);
  const expenseId = (settlementRow as { splitwise_expense_id: string | null }).splitwise_expense_id;

  if (expenseId) {
    const result = await deleteSplitwiseExpense(expenseId);
    if (!result.ok) {
      throw new Error(
        `Could not remove it from Splitwise (${result.error}). Nothing was reopened.`,
      );
    }
  }

  const { data: weekRows, error: weeksErr } = await supabase
    .from("weeks")
    .select("week_start")
    .eq("settlement_id", week.settlement_id);
  if (weeksErr) fail("reopenWeek/lookup", weeksErr);
  const weekIds = (weekRows as { week_start: string }[]).map((w) => w.week_start);

  // Someone else already reopened this settlement's weeks (a genuine race
  // between two devices reopening the same multi-week settlement) — nothing
  // left to clear, and an empty `.in()` list is invalid PostgREST (see
  // `editEntry`'s own comment about exactly this hazard). Nothing new
  // happened on this device, so nothing to log either.
  if (weekIds.length === 0) return;

  const { error: upErr } = await supabase
    .from("weeks")
    .update({ paid: false, paid_at: null, settlement_id: null })
    .in("week_start", weekIds);
  if (upErr) fail("reopenWeek/weeks", upErr);

  for (const weekId of weekIds) {
    if (expenseId) {
      await logAction({
        actor,
        action: "splitwise_unpush",
        week_start: weekId,
        device_id: deviceId,
      });
    }
    await logAction({ actor, action: "reopen", week_start: weekId, device_id: deviceId });
  }
}

// ── people ──

/** Add someone. Names are lowercased and trimmed, as the gate expects. */
export async function addPerson(name: string, actor: string, deviceId: string): Promise<void> {
  const clean = normalizeName(name);
  // The boundary re-checks rather than trusting its caller. A blank name is
  // accepted by `users.name` (not null, but '' is allowed), invisible in the
  // list, and can never log in — and there is no rename to fix it with.
  if (!clean) throw new Error("A person needs a name.");
  const { error } = await supabase.from("users").insert({ name: clean });
  if (error) fail("addPerson", error);
  await logAction({ actor, action: "user_add", target: clean, device_id: deviceId });
}

/** Flip one of a person's two switches. */
export async function setPersonFlag(
  user: User,
  field: "in_split" | "can_login",
  value: boolean,
  actor: string,
  deviceId: string,
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({ [field]: value })
    .eq("id", user.id);
  if (error) fail("setPersonFlag", error);
  const action: LogAction =
    field === "in_split"
      ? value
        ? "user_split_on"
        : "user_split_off"
      : value
        ? "user_login_on"
        : "user_login_off";
  await logAction({ actor, action, target: user.name, device_id: deviceId });
}

/**
 * Permanently remove someone. Only reachable for a person holding no shares —
 * the database refuses the rest via `on delete restrict`, so a bug here becomes
 * an error rather than orphaned history.
 */
export async function deletePerson(user: User, actor: string, deviceId: string): Promise<void> {
  const { error } = await supabase.from("users").delete().eq("id", user.id);
  if (error) fail("deletePerson", error);
  await logAction({ actor, action: "user_delete", target: user.name, device_id: deviceId });
}

/** Does this person appear in any add? Decides whether deletion is offered. */
export async function hasShares(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("entry_shares")
    .select("entry_id")
    .eq("user_id", userId)
    .limit(1);
  if (error) fail("hasShares", error);
  return (data ?? []).length > 0;
}

// ── Splitwise ──

/** Check a Splitwise email against the live group's members (§4.1/§9.1). */
export async function checkSplitwiseLink(
  email: string,
): Promise<{ linked: boolean; splitwiseUserId: string | null }> {
  const { data, error } = await supabase.functions.invoke("splitwise", {
    body: { action: "link", email },
  });
  if (error) fail("checkSplitwiseLink", error);
  const result = data as { linked?: boolean; splitwise_user_id?: string };
  // The edge function call can fail open into an unexpected shape (e.g. a
  // `config` error response with no `linked` field at all) — normalize so
  // callers always get a real boolean, never `undefined` masquerading as one.
  return { linked: result.linked === true, splitwiseUserId: result.splitwise_user_id ?? null };
}

/**
 * Save (or clear) a person's Splitwise email, re-checking it against the
 * live group every time (§4.2) — the stored `splitwise_user_id` is only a
 * People-sheet hint, never trusted at push time.
 */
export async function setSplitwiseEmail(user: User, email: string): Promise<void> {
  const clean = email.trim();
  const link = clean ? await checkSplitwiseLink(clean) : { linked: false, splitwiseUserId: null };
  const { error } = await supabase
    .from("users")
    .update({ splitwise_email: clean || null, splitwise_user_id: link.splitwiseUserId })
    .eq("id", user.id);
  if (error) fail("setSplitwiseEmail", error);
}

/** Delete a Splitwise expense. Treats "already gone" (per the edge
 * function) the same as a fresh success. */
export async function deleteSplitwiseExpense(
  expenseId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("splitwise", {
    body: { action: "delete", expense_id: expenseId },
  });
  if (error) return { ok: false, error: "network" };
  return data as { ok: boolean; error?: string };
}

export type PushResult =
  | { ok: true; expenseId: string }
  | { ok: false; status?: "unknown"; error?: string; detail?: string };

/**
 * Push a settlement to Splitwise. On an ambiguous outcome (network error,
 * dropped connection) the settlement is marked `splitwise_status: 'unknown'`
 * rather than silently retried (§4.9) — the caller is expected to require an
 * explicit re-confirmation before calling this again for the same settlement.
 */
export async function pushSettlement(
  settlementId: string,
  payer: User,
  people: SplitwisePerson[],
  totalCost: number,
  description: string,
  date: string,
  actor: string,
  deviceId: string,
  weekIds: string[],
): Promise<PushResult> {
  if (!payer.splitwise_email) {
    throw new Error("The chosen payer isn't linked to Splitwise.");
  }

  let invokeFailed = false;
  let data: { ok: boolean; expense_id?: string; error?: string; detail?: string } | undefined;
  try {
    const res = await supabase.functions.invoke("splitwise", {
      body: {
        action: "push",
        payerEmail: payer.splitwise_email,
        people,
        totalCost,
        description,
        date,
        currency: SPLITWISE_CURRENCY,
        categoryName: SPLITWISE_CATEGORY_NAME,
      },
    });
    if (res.error) invokeFailed = true;
    else data = res.data as { ok: boolean; expense_id?: string; error?: string; detail?: string };
  } catch {
    invokeFailed = true;
  }

  if (invokeFailed || !data) {
    const { error } = await supabase
      .from("settlements")
      .update({ splitwise_status: "unknown" })
      .eq("id", settlementId);
    if (error) fail("pushSettlement/markUnknown", error);
    return { ok: false, status: "unknown" };
  }

  if (!data.ok || !data.expense_id) {
    return { ok: false, error: data.error ?? "unknown_error", detail: data.detail };
  }

  // Conditioned on `splitwise_expense_id` still being null: if two devices
  // push the same settlement concurrently, both calls above can succeed at
  // Splitwise (two real expenses created), and without this guard whichever
  // write lands second would silently overwrite the first's expense id,
  // losing all record of it. With the guard, the loser detects the race
  // instead (see `already_pushed` below) rather than clobbering the winner.
  const { data: updated, error } = await supabase
    .from("settlements")
    .update({
      splitwise_expense_id: data.expense_id,
      splitwise_payer_user_id: payer.id,
      splitwise_pushed_at: new Date().toISOString(),
      splitwise_status: null,
    })
    .eq("id", settlementId)
    .is("splitwise_expense_id", null)
    .select("id")
    .maybeSingle();
  if (error) fail("pushSettlement/save", error);
  if (!updated) {
    // Someone else already recorded a push for this settlement while our own
    // Splitwise call was in flight. Our call may have just created a genuine
    // duplicate expense there — surface this distinctly so the UI can tell
    // the user to check Splitwise, rather than treating it as an ordinary
    // success or a generic failure.
    return { ok: false, error: "already_pushed" };
  }

  for (const weekId of weekIds) {
    await logAction({
      actor,
      action: "splitwise_push",
      week_start: weekId,
      detail: `${description} · ${money(totalCost)} · paid by ${cap(payer.name)}`,
      device_id: deviceId,
    });
  }

  return { ok: true, expenseId: data.expense_id };
}

// ── push notifications ──

/**
 * Record (or refresh) this device's push subscription.
 *
 * An insert with a fallback update, rather than `.upsert()`: PostgREST's
 * upsert compiles to `on conflict do update`, which Postgres only allows with
 * table-wide select privilege — and this table deliberately withholds select
 * on `p256dh`/`auth` so the anon key cannot read the key material for
 * messaging everyone's phones. `23505` is the unique violation on `endpoint`,
 * i.e. this device is already known: the same device re-subscribing, or a
 * different person signing in on it.
 */
export async function savePushSubscription(
  sub: PushKeys,
  userName: string,
  deviceId: string,
): Promise<void> {
  const row = {
    endpoint: sub.endpoint,
    p256dh: sub.p256dh,
    auth: sub.auth,
    user_name: userName,
    device_id: deviceId,
    last_seen_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("push_subscriptions").insert(row);
  if (!error) return;
  if (error.code !== "23505") fail("savePushSubscription/insert", error);

  const { error: upErr } = await supabase
    .from("push_subscriptions")
    .update(row)
    .eq("endpoint", sub.endpoint);
  if (upErr) fail("savePushSubscription/update", upErr);
}

/**
 * Point an existing subscription at whoever just signed in on this device.
 *
 * This is the only thing keeping "skip the actor" honest when a phone changes
 * hands: without it the new person would be skipped under the old person's
 * name, and notified about their own adds.
 */
export async function rebindPushSubscription(
  endpoint: string,
  userName: string,
  deviceId: string,
): Promise<void> {
  const { error } = await supabase
    .from("push_subscriptions")
    .update({ user_name: userName, device_id: deviceId, last_seen_at: new Date().toISOString() })
    .eq("endpoint", endpoint);
  if (error) fail("rebindPushSubscription", error);
}

/** Forget a device. The browser has already unsubscribed by this point. */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) fail("deletePushSubscription", error);
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
    .on("postgres_changes", { event: "*", schema: "public", table: "settlements" }, onChange)
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
