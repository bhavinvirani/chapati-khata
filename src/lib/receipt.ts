import type { Entry } from "../types";
import { DEFAULT_PRICE } from "../config";
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
  /** Per-rate sub-lines, populated only when the day isn't uniformly at
   * DEFAULT_PRICE — see shouldBreakOutRates. */
  rates: RateGroup[];
}

export interface ReceiptData {
  days: ReceiptDay[]; // oldest first
  totalDays: number;
  totalQty: number;
  totalAmount: number;
}

/**
 * A day is worth breaking into per-rate lines once it isn't simply "every
 * chapati at the one default price" — a single custom-rate day is exactly as
 * worth surfacing as a mixed-rate one.
 */
export function shouldBreakOutRates(rates: RateGroup[]): boolean {
  if (rates.length > 1) return true;
  return rates.length === 1 && rates[0].rate !== DEFAULT_PRICE;
}

/**
 * Builds the day-by-day figures a payment receipt image shows, oldest day
 * first (a bill reads forward in time) — the reverse of groupByDay's
 * newest-first order, which exists for the app's own scan-what's-recent
 * lists.
 */
export function buildReceiptData(entries: Entry[]): ReceiptData {
  const days: ReceiptDay[] = [...groupByDay(entries)].reverse().map((d) => {
    const rates = rateBreakdown(d.adds);
    return {
      day: d.day,
      qty: d.qty,
      amount: d.amount,
      rates: shouldBreakOutRates(rates) ? rates : [],
    };
  });
  return {
    days,
    totalDays: days.length,
    totalQty: days.reduce((sum, d) => sum + d.qty, 0),
    totalAmount: round2(days.reduce((sum, d) => sum + d.amount, 0)),
  };
}
