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
      adds,
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
  return shares.reduce((sum, s) => sum + s.qty, 0) !== entry.qty;
}

/** A person's name for display, never a raw uuid. */
export function nameOf(users: User[], userId: string): string {
  return users.find((u) => u.id === userId)?.name ?? "unknown";
}
