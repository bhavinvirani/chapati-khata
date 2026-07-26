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
 * Turn an allocation into rows to persist.
 *
 * `otherQty` is the guest bucket, and `sharerIds` is who covers it — everyone
 * in the split by default, or a chosen few. A sharer who took nothing still
 * gets a row: they owe money, and money without a row cannot be shown or
 * settled. That is why `entry_shares.qty` permits 0.
 *
 * The guest cost is divided in whole cents by largest remainder rather than by
 * dividing the count, because a count rarely divides: 5 guest chapatis across
 * 7 people is not an integer, but 500 cents is. Handing the leftover cents to
 * the earliest ids means the shares sum to exactly what the guests cost — no
 * cent invented, none lost. Sorting first makes which people absorb the
 * leftover deterministic, so the same allocation always produces the same rows.
 *
 * A row with neither a count nor money is never written — that is somebody who
 * was simply not part of this add.
 */
export function buildShares(
  rows: Alloc,
  rate: number,
  otherQty = 0,
  sharerIds: string[] = [],
): ShareInput[] {
  const byId = (a: string, b: string) => a.localeCompare(b);
  const sharers = otherQty > 0 ? [...new Set(sharerIds)].sort(byId) : [];

  const poolCents = Math.round(round2(otherQty * rate) * 100);
  const each = sharers.length > 0 ? Math.floor(poolCents / sharers.length) : 0;
  const leftover = sharers.length > 0 ? poolCents - each * sharers.length : 0;
  const slice = new Map<string, number>();
  sharers.forEach((id, i) => slice.set(id, each + (i < leftover ? 1 : 0)));

  const ate = Object.keys(rows).filter((id) => rows[id] > 0);
  return [...new Set([...ate, ...sharers])]
    .sort(byId)
    .map((user_id) => {
      const qty = rows[user_id] > 0 ? rows[user_id] : 0;
      return {
        user_id,
        qty,
        amount: round2(round2(qty * rate) + (slice.get(user_id) ?? 0) / 100),
      };
    })
    .filter((s) => s.qty > 0 || s.amount > 0);
}

/**
 * The add's stored amount. Deliberately the sum of the already-rounded shares
 * rather than round2(total * rate): at an awkward rate the two differ by a
 * cent, and that discrepancy belongs on the group total, not on the split.
 */
export function sharesAmount(shares: ShareInput[]): number {
  return round2(shares.reduce((sum, s) => sum + s.amount, 0));
}
