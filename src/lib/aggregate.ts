import type { Entry, User } from "../types";
import { round2 } from "./util";

// Turning stored rows into the figures the UI shows. Pure — the display layer
// does no arithmetic of its own.

export interface PersonTotal {
  userId: string;
  qty: number;
  amount: number;
}

/** One calendar day and the adds recorded against it. */
export interface DayGroup {
  day: string;
  adds: Entry[];
  qty: number;
  amount: number;
}

/**
 * Per-person totals across any set of adds, biggest spender first.
 *
 * Money accumulates from the stored share amounts rather than being recomputed
 * from a rate, which is what keeps two runs at different rates exact.
 */
export function perPerson(entries: Entry[]): PersonTotal[] {
  const byUser = new Map<string, PersonTotal>();
  for (const e of entries) {
    for (const s of e.entry_shares ?? []) {
      const row = byUser.get(s.user_id) ?? { userId: s.user_id, qty: 0, amount: 0 };
      row.qty += s.qty;
      row.amount = round2(row.amount + s.amount);
      byUser.set(s.user_id, row);
    }
  }
  return [...byUser.values()].sort((a, b) => b.amount - a.amount);
}

/** Adds grouped under their day, newest day first. */
export function groupByDay(entries: Entry[]): DayGroup[] {
  const byDay = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = byDay.get(e.day) ?? [];
    arr.push(e);
    byDay.set(e.day, arr);
  }
  return [...byDay.entries()]
    .map(([day, adds]) => ({
      day,
      // Oldest run first. Nothing in the queries orders adds, and an UPDATE
      // moves a row's heap position, so without this the morning and evening
      // runs can swap places after an edit.
      adds: [...adds].sort((a, b) => a.created_at.localeCompare(b.created_at)),
      qty: adds.reduce((sum, a) => sum + a.qty, 0),
      amount: round2(adds.reduce((sum, a) => sum + a.amount, 0)),
    }))
    .sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * True when an add's shares are missing or do not add up to its total.
 *
 * Writes are not transactional (see the spec's §7), so a dropped connection
 * can leave an add without its shares. This is how the UI notices.
 */
export function needsRepair(entry: Entry): boolean {
  const shares = entry.entry_shares ?? [];
  if (shares.length === 0) return true;
  // The guest bucket is part of the total but has no share row of its own, so
  // it belongs on this side of the comparison. Leaving it out would flag every
  // add that fed a guest as broken.
  const claimed = shares.reduce((sum, s) => sum + s.qty, 0) + (entry.other_qty ?? 0);
  if (claimed !== entry.qty) return true;
  // Money needs a tolerance rather than `!==`: both sides are float sums of
  // numeric(10,2) values, so 0.1 + 0.2 must still count as agreeing with 0.30.
  // Anything genuinely wrong is out by at least a cent.
  const amount = round2(shares.reduce((sum, s) => sum + s.amount, 0));
  return Math.abs(amount - entry.amount) > 0.005;
}

/**
 * Chapatis eaten by guests across these adds.
 *
 * Kept separate from `perPerson` rather than faked as a person: guests own no
 * money — the people who ate absorbed it — so a synthetic row would have to
 * carry an amount of zero and would then distort any "biggest spender" order.
 * The lists render this as its own line so the counts still reconcile against
 * the day and week totals.
 */
export function otherQty(entries: Entry[]): number {
  return entries.reduce((sum, e) => sum + (e.other_qty ?? 0), 0);
}

/** A person's name for display, never a raw uuid. */
export function nameOf(users: User[], userId: string): string {
  return users.find((u) => u.id === userId)?.name ?? "unknown";
}
