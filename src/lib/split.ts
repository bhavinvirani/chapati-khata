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

/**
 * Positive means chapatis are still unassigned; negative means over-allocated.
 *
 * `otherQty` is the guest bucket — chapatis nobody on the list claimed. They
 * count against the total like anyone else's, so a day is only fully allocated
 * once the people and the guests together account for it.
 */
export function remaining(total: number, rows: Alloc, otherQty = 0): number {
  return total - allocated(rows) - otherQty;
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
 *
 * `otherQty` is the guest bucket. Guests cost real money that nobody claimed,
 * so the people who did eat absorb it — and only them, not everyone in the
 * split, because you should not pay for a guest on a day you were not there.
 *
 * The guest cost is divided in whole cents by largest remainder rather than by
 * dividing the count, because a count rarely divides: 10 guest chapatis across
 * 7 people is not an integer, but 500 cents is. Distributing in cents and
 * handing the leftover ones to the earliest ids means the shares still sum to
 * exactly what the guests cost — no cent invented, none lost. Sorting by id
 * first makes which people absorb the leftover deterministic, so the same
 * allocation always produces the same rows.
 */
export function buildShares(rows: Alloc, rate: number, otherQty = 0): ShareInput[] {
  const eaters = Object.entries(rows)
    .filter(([, qty]) => qty > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (eaters.length === 0) return [];

  const poolCents = Math.round(round2(otherQty * rate) * 100);
  const each = Math.floor(poolCents / eaters.length);
  const leftover = poolCents - each * eaters.length;

  return eaters.map(([user_id, qty], i) => ({
    user_id,
    qty,
    amount: round2(round2(qty * rate) + (each + (i < leftover ? 1 : 0)) / 100),
  }));
}

/**
 * The add's stored amount. Deliberately the sum of the already-rounded shares
 * rather than round2(total * rate): at an awkward rate the two differ by a
 * cent, and that discrepancy belongs on the group total, not on the split.
 */
export function sharesAmount(shares: ShareInput[]): number {
  return round2(shares.reduce((sum, s) => sum + s.amount, 0));
}
