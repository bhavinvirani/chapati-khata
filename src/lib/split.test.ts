import { describe, expect, it } from "vitest";
import { allocated, buildShares, evenSplit, remaining, sharesAmount } from "./split";

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
