import { describe, expect, it } from "vitest";
import type { Entry } from "../types";
import { buildReceiptData } from "./receipt";

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
    entry_shares: [],
    ...over,
  };
}

describe("buildReceiptData", () => {
  it("orders days oldest first", () => {
    const mon = entry({ id: "e1", day: "2026-07-20" });
    const wed = entry({ id: "e2", day: "2026-07-22" });
    const data = buildReceiptData([wed, mon]);
    expect(data.days.map((d) => d.day)).toEqual(["2026-07-20", "2026-07-22"]);
  });

  it("states the rate even for a uniform default-rate day", () => {
    const data = buildReceiptData([entry({ rate: 0.5, qty: 12, amount: 6 })]);
    expect(data.days[0].rates).toEqual([{ rate: 0.5, qty: 12, amount: 6 }]);
  });

  it("breaks out a mixed-rate day", () => {
    const cheap = entry({ id: "e1", rate: 0.5, qty: 10, amount: 5 });
    const pricey = entry({ id: "e2", rate: 1, qty: 5, amount: 5 });
    const data = buildReceiptData([cheap, pricey]);
    expect(data.days[0].rates).toEqual([
      { rate: 0.5, qty: 10, amount: 5 },
      { rate: 1, qty: 5, amount: 5 },
    ]);
  });

  it("breaks out a single custom-rate day", () => {
    const data = buildReceiptData([entry({ rate: 0.75, qty: 12, amount: 9 })]);
    expect(data.days[0].rates).toEqual([{ rate: 0.75, qty: 12, amount: 9 }]);
  });

  it("totals across days and rounds money", () => {
    const a = entry({ id: "e1", day: "2026-07-20", qty: 10, amount: 0.1 });
    const b = entry({ id: "e2", day: "2026-07-21", qty: 7, amount: 0.2 });
    const data = buildReceiptData([a, b]);
    expect(data.totalDays).toBe(2);
    expect(data.totalQty).toBe(17);
    expect(data.totalAmount).toBe(0.3);
  });

  it("merges entries across week boundaries into one chronological list", () => {
    const wk1 = entry({ id: "e1", week_start: "2026-07-13", day: "2026-07-17" });
    const wk2 = entry({ id: "e2", week_start: "2026-07-20", day: "2026-07-21" });
    const data = buildReceiptData([wk2, wk1]);
    expect(data.days.map((d) => d.day)).toEqual(["2026-07-17", "2026-07-21"]);
  });

  it("is empty for no entries", () => {
    const data = buildReceiptData([]);
    expect(data).toEqual({ days: [], totalDays: 0, totalQty: 0, totalAmount: 0 });
  });
});
