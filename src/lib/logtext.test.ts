import { describe, expect, it } from "vitest";
import type { User } from "../types";
import { describeAdd, describeEdit } from "./logtext";

const A = "id-a";
const B = "id-b";
const C = "id-c";

const users: User[] = [
  { id: A, name: "bhavin", in_split: true, can_login: true, created_at: "2026-07-01T00:00:00Z" },
  { id: B, name: "deven", in_split: true, can_login: true, created_at: "2026-07-01T00:00:00Z" },
  { id: C, name: "samir", in_split: true, can_login: true, created_at: "2026-07-01T00:00:00Z" },
];

const add = (over: Partial<Parameters<typeof describeAdd>[0]> = {}) => ({
  qty: 12,
  rate: 0.5,
  otherQty: 0,
  shares: [
    { user_id: A, qty: 7 },
    { user_id: B, qty: 5 },
  ],
  ...over,
});

describe("describeAdd", () => {
  it("names the total, the rate and who ate", () => {
    expect(describeAdd(add(), users)).toBe("12 @ $0.50 · Bhavin 7 · Deven 5");
  });

  it("mentions guests when there were any", () => {
    expect(describeAdd(add({ qty: 17, otherQty: 5 }), users)).toBe(
      "17 @ $0.50 · Bhavin 7 · Deven 5 · guests 5",
    );
  });

  it("omits people who only covered guests from the who-ate list", () => {
    const guestsOnly = add({ qty: 5, otherQty: 5, shares: [{ user_id: A, qty: 0 }] });
    expect(describeAdd(guestsOnly, users)).toBe("5 @ $0.50 · guests 5");
  });
});

describe("describeEdit", () => {
  // The gap that prompted this: quantities unchanged, so the old log said
  // nothing at all beyond "edited".
  it("reports a rate-only change that leaves every quantity alone", () => {
    expect(describeEdit(add(), add({ rate: 0.75 }), users)).toBe("rate $0.50 → $0.75");
  });

  it("reports a guests-only change", () => {
    expect(describeEdit(add(), add({ qty: 17, otherQty: 5 }), users)).toBe(
      "total 12 → 17 · guests 0 → 5",
    );
  });

  it("names a person joining and a person leaving", () => {
    const after = add({
      shares: [
        { user_id: A, qty: 7 },
        { user_id: C, qty: 5 },
      ],
    });
    expect(describeEdit(add(), after, users)).toBe("Deven 5 → — · Samir — → 5");
  });

  it("reports a shifted allocation at an unchanged total", () => {
    const after = add({
      shares: [
        { user_id: A, qty: 9 },
        { user_id: B, qty: 3 },
      ],
    });
    expect(describeEdit(add(), after, users)).toBe("Bhavin 7 → 9 · Deven 5 → 3");
  });

  it("says so plainly when nothing moved", () => {
    expect(describeEdit(add(), add(), users)).toBe("no change");
  });

  it("does not invent a rate change from float noise", () => {
    expect(describeEdit(add({ rate: 0.1 + 0.2 }), add({ rate: 0.3 }), users)).toBe("no change");
  });
});
