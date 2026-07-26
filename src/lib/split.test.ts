import { describe, expect, it } from "vitest";
import { allocated, buildShares, evenSplit, remaining, sharesAmount } from "./split";
import { round2 } from "./util";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";

describe("allocated", () => {
  it("sums the rows", () => {
    expect(allocated({ [A]: 7, [B]: 5 })).toBe(12);
  });

  it("is zero for an empty allocation", () => {
    expect(allocated({})).toBe(0);
  });

  it("ignores blank rows", () => {
    expect(allocated({ [A]: 7, [B]: 0 })).toBe(7);
  });
});

describe("remaining", () => {
  it("is positive when under-allocated", () => {
    expect(remaining(45, { [A]: 20 })).toBe(25);
  });

  it("is zero when exact", () => {
    expect(remaining(12, { [A]: 7, [B]: 5 })).toBe(0);
  });

  it("is negative when over-allocated", () => {
    expect(remaining(10, { [A]: 7, [B]: 5 })).toBe(-2);
  });

  it("counts the guest bucket against the total", () => {
    expect(remaining(50, { [A]: 30, [B]: 10 }, 10)).toBe(0);
  });

  it("still leaves a remainder when the guests do not close the gap", () => {
    expect(remaining(50, { [A]: 30 }, 10)).toBe(10);
  });
});

describe("evenSplit", () => {
  it("divides exactly when it divides exactly", () => {
    expect(evenSplit(21, [A, B, C])).toEqual({ [A]: 7, [B]: 7, [C]: 7 });
  });

  it("gives the remainder to the first people in order", () => {
    expect(evenSplit(23, [A, B, C])).toEqual({ [A]: 8, [B]: 8, [C]: 7 });
  });

  it("still sums to the total when the remainder is spread", () => {
    const split = evenSplit(45, [A, B, C]);
    expect(allocated(split)).toBe(45);
  });

  it("handles a single person", () => {
    expect(evenSplit(9, [A])).toEqual({ [A]: 9 });
  });

  it("returns nothing when there is nobody to split across", () => {
    expect(evenSplit(9, [])).toEqual({});
  });

  it("gives everything to the first people when there are more people than chapatis", () => {
    expect(evenSplit(2, [A, B, C])).toEqual({ [A]: 1, [B]: 1, [C]: 0 });
  });
});

describe("buildShares", () => {
  it("prices each share at the add's rate", () => {
    expect(buildShares({ [A]: 7, [B]: 5 }, 0.5)).toEqual([
      { user_id: A, qty: 7, amount: 3.5 },
      { user_id: B, qty: 5, amount: 2.5 },
    ]);
  });

  it("omits people who took nothing rather than storing a zero", () => {
    expect(buildShares({ [A]: 7, [B]: 0 }, 0.5)).toEqual([{ user_id: A, qty: 7, amount: 3.5 }]);
  });

  it("rounds each share to the cent", () => {
    expect(buildShares({ [A]: 3 }, 0.125)).toEqual([{ user_id: A, qty: 3, amount: 0.38 }]);
  });
});

describe("buildShares with a guest bucket", () => {
  // The user's own example: 50 chapatis at $0.50, six people at 5, one at 10,
  // and 10 to guests. The guest chapatis cost $5.00, which the seven who ate
  // absorb — 500 cents over 7 is 71 each with 3 cents left over.
  it("spreads the guest cost across the people who ate, to the exact cent", () => {
    const ids = [A, B, C, "d", "e", "f", "g"];
    const rows: Record<string, number> = {};
    ids.forEach((id, i) => (rows[id] = i === 6 ? 10 : 5));
    const shares = buildShares(rows, 0.5, 10, ids);

    expect(shares).toHaveLength(7);
    expect(sharesAmount(shares)).toBe(25);
    // Every share is its own chapatis plus a guest slice, never bare qty x rate.
    expect(shares.every((s) => s.amount > round2(s.qty * 0.5))).toBe(true);
  });

  it("gives the leftover cents to the earliest ids, so the sum is exact", () => {
    const shares = buildShares({ [A]: 1, [B]: 1, [C]: 1 }, 0.5, 1, [A, B, C]);
    // 50 cents over 3 people: 16 each, 2 left over.
    expect(shares.map((s) => s.amount)).toEqual([0.67, 0.67, 0.66]);
    expect(sharesAmount(shares)).toBe(2);
  });

  it("is deterministic regardless of the order keys were entered", () => {
    const forwards = buildShares({ [A]: 1, [B]: 1, [C]: 1 }, 0.5, 1, [A, B, C]);
    const backwards = buildShares({ [C]: 1, [B]: 1, [A]: 1 }, 0.5, 1, [C, B, A]);
    expect(backwards).toEqual(forwards);
  });

  it("leaves the shares untouched when there are no guests", () => {
    expect(buildShares({ [A]: 7, [B]: 5 }, 0.5, 0, [A, B])).toEqual(
      buildShares({ [A]: 7, [B]: 5 }, 0.5),
    );
  });

  it("charges nobody when guests ate but no person did", () => {
    expect(buildShares({}, 0.5, 10, [])).toEqual([]);
  });

  it("gives a lone eater the whole guest cost", () => {
    expect(buildShares({ [A]: 4 }, 0.5, 6, [A])).toEqual([{ user_id: A, qty: 4, amount: 5 }]);
  });
});

describe("buildShares with a selective guest bucket", () => {
  // The reported edge case: everything in Others, nobody takes a personal
  // count. Previously this produced no rows at all and the add was refused.
  it("charges the sharers when nobody took a personal count", () => {
    const shares = buildShares({}, 1, 5, [A, B, C]);
    expect(shares.map((s) => [s.qty, s.amount])).toEqual([
      [0, 1.67],
      [0, 1.67],
      [0, 1.66],
    ]);
    expect(sharesAmount(shares)).toBe(5);
  });

  it("charges only the chosen few, not everyone offered", () => {
    const shares = buildShares({ [A]: 2 }, 1, 5, [B, C]);
    expect(shares).toEqual([
      { user_id: A, qty: 2, amount: 2 },
      { user_id: B, qty: 0, amount: 2.5 },
      { user_id: C, qty: 0, amount: 2.5 },
    ]);
    expect(sharesAmount(shares)).toBe(7);
  });

  it("gives an eater who is also a sharer both parts", () => {
    const shares = buildShares({ [A]: 2 }, 1, 5, [A, B]);
    expect(shares).toEqual([
      { user_id: A, qty: 2, amount: 4.5 },
      { user_id: B, qty: 0, amount: 2.5 },
    ]);
    expect(sharesAmount(shares)).toBe(7);
  });

  it("writes no row for somebody who neither ate nor shared", () => {
    expect(buildShares({ [A]: 3 }, 1, 2, [B]).map((s) => s.user_id)).toEqual([A, B]);
  });

  it("drops the guest cost entirely when nobody is chosen to cover it", () => {
    // The composer refuses to save in this state; the maths still must not
    // invent a charge for someone who was not picked.
    expect(buildShares({ [A]: 3 }, 1, 2, [])).toEqual([{ user_id: A, qty: 3, amount: 3 }]);
  });
});

describe("sharesAmount", () => {
  it("sums the share amounts", () => {
    expect(sharesAmount(buildShares({ [A]: 7, [B]: 5 }, 0.5))).toBe(6);
  });

  // The invariant that makes per-person figures reconcile: the add's amount is
  // the sum of its (already rounded) shares, NOT round2(total * rate). At an
  // awkward rate those differ, and the discrepancy belongs on the group total.
  it("can differ from pricing the total in one go, and that is intended", () => {
    const shares = buildShares({ [A]: 1, [B]: 1, [C]: 1 }, 0.125);
    expect(sharesAmount(shares)).toBe(0.39);
    expect(sharesAmount(shares)).not.toBe(0.38); // round2(3 * 0.125)
  });
});
