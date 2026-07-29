import { describe, expect, it } from "vitest";
import type { Entry, EntryShare } from "../types";
import { groupByDay, nameOf, needsRepair, otherQty, perPerson, rateBreakdown } from "./aggregate";

const A = "user-a";
const B = "user-b";

function share(user_id: string, qty: number, amount: number): EntryShare {
  return { entry_id: "e1", user_id, qty, amount };
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    week_start: "2026-07-20",
    day: "2026-07-22",
    qty: 12,
    rate: 0.5,
    amount: 6,
    note: "",
    other_qty: 0,
    created_at: "2026-07-22T09:00:00Z",
    entry_shares: [share(A, 7, 3.5), share(B, 5, 2.5)],
    ...over,
  };
}

describe("perPerson", () => {
  it("totals one add", () => {
    expect(perPerson([entry()])).toEqual([
      { userId: A, qty: 7, amount: 3.5 },
      { userId: B, qty: 5, amount: 2.5 },
    ]);
  });

  it("accumulates the same person across several adds", () => {
    const morning = entry({ id: "e1", entry_shares: [share(A, 7, 3.5)] });
    const evening = entry({ id: "e2", rate: 0.75, entry_shares: [share(A, 10, 7.5)] });
    expect(perPerson([morning, evening])).toEqual([{ userId: A, qty: 17, amount: 11 }]);
  });

  it("keeps money exact across two runs at different rates", () => {
    // The reason rate is per-add: at a blended rate this comes out $9.81.
    const morning = entry({ id: "e1", rate: 0.5, entry_shares: [share(A, 7, 3.5)] });
    const evening = entry({ id: "e2", rate: 0.75, entry_shares: [share(A, 10, 7.5)] });
    expect(perPerson([morning, evening])[0].amount).toBe(11);
  });

  it("sorts by spend, biggest first", () => {
    const rows = perPerson([entry()]);
    expect(rows[0].userId).toBe(A);
  });

  it("is empty when nothing is split", () => {
    expect(perPerson([entry({ entry_shares: [] })])).toEqual([]);
  });
});

describe("groupByDay", () => {
  it("puts several adds under one day, newest day first", () => {
    const wed = entry({ id: "e1", day: "2026-07-22" });
    const wedAgain = entry({ id: "e2", day: "2026-07-22" });
    const thu = entry({ id: "e3", day: "2026-07-23" });
    const days = groupByDay([wed, wedAgain, thu]);
    expect(days.map((d) => d.day)).toEqual(["2026-07-23", "2026-07-22"]);
    expect(days[1].adds).toHaveLength(2);
  });

  it("totals each day across its adds", () => {
    const morning = entry({ id: "e1", day: "2026-07-22", qty: 45, amount: 22.5 });
    const evening = entry({ id: "e2", day: "2026-07-22", qty: 20, amount: 15 });
    const [wed] = groupByDay([morning, evening]);
    expect(wed.qty).toBe(65);
    expect(wed.amount).toBe(37.5);
  });

  // Nothing in the queries orders adds, and an UPDATE moves a row's heap
  // position, so a same-day pair must come back oldest-first regardless of
  // the order they arrived in.
  it("orders same-day adds oldest first, regardless of input order", () => {
    const morning = entry({ id: "e1", day: "2026-07-22", created_at: "2026-07-22T09:00:00Z" });
    const evening = entry({ id: "e2", day: "2026-07-22", created_at: "2026-07-22T18:00:00Z" });
    const [wed] = groupByDay([evening, morning]);
    expect(wed.adds.map((a) => a.id)).toEqual(["e1", "e2"]);
  });
});

describe("needsRepair", () => {
  it("passes a well-formed add", () => {
    expect(needsRepair(entry())).toBe(false);
  });

  it("flags an add whose shares never landed", () => {
    expect(needsRepair(entry({ entry_shares: [] }))).toBe(true);
  });

  it("does not flag an add whose gap is exactly the guest bucket", () => {
    // 12 to people + 10 to guests = a stored total of 22. Counting only the
    // share rows would call this broken.
    expect(needsRepair(entry({ qty: 22, other_qty: 10 }))).toBe(false);
  });

  it("still flags an add whose guest bucket does not close the gap", () => {
    expect(needsRepair(entry({ qty: 22, other_qty: 4 }))).toBe(true);
  });

  it("flags an add whose shares do not sum to its total", () => {
    expect(needsRepair(entry({ qty: 20 }))).toBe(true);
  });

  // A rate-only edit rewrites every share's amount but no share's qty. If the
  // entry-row update then fails, the qty check alone would see nothing wrong.
  it("flags an add whose share amounts do not sum to its amount", () => {
    expect(needsRepair(entry({ amount: 9 }))).toBe(true);
  });

  it("tolerates float noise in summed money", () => {
    const shares = [share(A, 1, 0.1), share(B, 1, 0.2)];
    expect(needsRepair(entry({ qty: 2, amount: 0.3, entry_shares: shares }))).toBe(false);
  });
});

describe("otherQty", () => {
  it("sums the guest buckets", () => {
    expect(otherQty([entry({ id: "e1", other_qty: 10 }), entry({ id: "e2", other_qty: 4 })])).toBe(
      14,
    );
  });

  it("is zero when no guests ate", () => {
    expect(otherQty([entry()])).toBe(0);
  });
});

describe("nameOf", () => {
  const users = [
    {
      id: A,
      name: "bhavin",
      in_split: true,
      can_login: true,
      created_at: "2026-07-01T00:00:00Z",
      splitwise_email: null,
      splitwise_user_id: null,
    },
  ];

  it("resolves a known id", () => {
    expect(nameOf(users, A)).toBe("bhavin");
  });

  it("falls back rather than rendering a raw uuid", () => {
    expect(nameOf(users, "ghost")).toBe("unknown");
  });
});

describe("rateBreakdown", () => {
  it("collapses one add into a single rate group", () => {
    expect(rateBreakdown([entry({ rate: 0.5, qty: 12, amount: 6 })])).toEqual([
      { rate: 0.5, qty: 12, amount: 6 },
    ]);
  });

  it("groups same-rate adds together", () => {
    const a = entry({ id: "e1", rate: 0.75, qty: 20, amount: 15 });
    const b = entry({ id: "e2", rate: 0.75, qty: 5, amount: 3.75 });
    expect(rateBreakdown([a, b])).toEqual([{ rate: 0.75, qty: 25, amount: 18.75 }]);
  });

  it("sorts distinct rates cheapest first", () => {
    const cheap = entry({ id: "e1", rate: 0.5, qty: 10, amount: 5 });
    const pricey = entry({ id: "e2", rate: 1, qty: 5, amount: 5 });
    expect(rateBreakdown([pricey, cheap]).map((r) => r.rate)).toEqual([0.5, 1]);
  });

  it("is empty for no adds", () => {
    expect(rateBreakdown([])).toEqual([]);
  });
});
