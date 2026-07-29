import type { Entry } from "../types";
import { groupByDay, rateBreakdown, type RateGroup } from "./aggregate";
import { round2 } from "./util";

// Pure data shaping for the payment receipt image. src/lib/receiptImage.ts
// draws it; this file only decides what goes on the receipt. Kept separate
// from aggregate.ts's general-purpose helpers since this is one feature's
// presentation rule, not a reusable aggregation.

export interface ReceiptDay {
  day: string;
  qty: number;
  amount: number;
  /** Every distinct rate charged that day, cheapest first — always at least
   * one entry, even a single uniform default-rate day, so the receipt always
   * states the price alongside the day's total. */
  rates: RateGroup[];
}

export interface ReceiptData {
  days: ReceiptDay[]; // oldest first
  totalDays: number;
  totalQty: number;
  totalAmount: number;
}

/**
 * Builds the day-by-day figures a payment receipt image shows, oldest day
 * first (a bill reads forward in time) — the reverse of groupByDay's
 * newest-first order, which exists for the app's own scan-what's-recent
 * lists.
 */
export function buildReceiptData(entries: Entry[]): ReceiptData {
  const days: ReceiptDay[] = [...groupByDay(entries)].reverse().map((d) => ({
    day: d.day,
    qty: d.qty,
    amount: d.amount,
    rates: rateBreakdown(d.adds),
  }));
  return {
    days,
    totalDays: days.length,
    totalQty: days.reduce((sum, d) => sum + d.qty, 0),
    totalAmount: round2(days.reduce((sum, d) => sum + d.amount, 0)),
  };
}
