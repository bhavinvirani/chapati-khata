import { round2 } from "./util";

// Pure allocation math for splitting one add across people. No I/O, no React —
// this is the whole of the arithmetic the entry flow depends on.

/** A work-in-progress allocation: user id -> chapatis. Blank rows may be 0. */
export type Alloc = Record<string, number>;

/** One person's share, shaped for insertion into entry_shares. */
export interface ShareInput {
  user_id: string;
  qty: number;
  amount: number;
}

/** Total chapatis handed out so far. */
export function allocated(rows: Alloc): number {
  return Object.values(rows).reduce((sum, qty) => sum + (qty || 0), 0);
}

/** Positive means chapatis are still unassigned; negative means over-allocated. */
export function remaining(total: number, rows: Alloc): number {
  return total - allocated(rows);
}

/**
 * Split `total` across `userIds`: everyone gets floor(total / n), and the
 * remainder is handed out one extra each to the first `r` people in order.
 * Deterministic, so the result is directly testable.
 */
export function evenSplit(total: number, userIds: string[]): Alloc {
  const out: Alloc = {};
  if (userIds.length === 0) return out;
  const base = Math.floor(total / userIds.length);
  const extra = total % userIds.length;
  userIds.forEach((id, i) => {
    out[id] = base + (i < extra ? 1 : 0);
  });
  return out;
}

/**
 * Turn an allocation into rows to persist. People who took nothing get no row
 * at all — "who was in this add" is exactly the set of rows present.
 */
export function buildShares(rows: Alloc, rate: number): ShareInput[] {
  return Object.entries(rows)
    .filter(([, qty]) => qty > 0)
    .map(([user_id, qty]) => ({ user_id, qty, amount: round2(qty * rate) }));
}

/**
 * The add's stored amount. Deliberately the sum of the already-rounded shares
 * rather than round2(total * rate): at an awkward rate the two differ by a
 * cent, and that discrepancy belongs on the group total, not on the split.
 */
export function sharesAmount(shares: ShareInput[]): number {
  return round2(shares.reduce((sum, s) => sum + s.amount, 0));
}
