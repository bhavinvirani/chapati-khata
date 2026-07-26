import { describe, expect, it } from "vitest";
import type { Entry, EntryShare } from "../types";
import { groupByDay, nameOf, needsRepair, perPerson } from "./aggregate";

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
});

describe("needsRepair", () => {
  it("passes a well-formed add", () => {
    expect(needsRepair(entry())).toBe(false);
  });

  it("flags an add whose shares never landed", () => {
    expect(needsRepair(entry({ entry_shares: [] }))).toBe(true);
  });

  it("flags an add whose shares do not sum to its total", () => {
    expect(needsRepair(entry({ qty: 20 }))).toBe(true);
  });
});

describe("nameOf", () => {
  const users = [
    { id: A, name: "bhavin", in_split: true, can_login: true, created_at: "2026-07-01T00:00:00Z" },
  ];

  it("resolves a known id", () => {
    expect(nameOf(users, A)).toBe("bhavin");
  });

  it("falls back rather than rendering a raw uuid", () => {
    expect(nameOf(users, "ghost")).toBe("unknown");
  });
});
