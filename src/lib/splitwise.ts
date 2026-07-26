import type { User } from "../types";
import type { PersonTotal } from "./aggregate";
import { cap, dateRangeLabel, parseYMD } from "./util";

// Pure helpers for the Splitwise push flow: building the expense description,
// mapping this app's per-person totals into the edge function's request
// shape, and spotting who isn't linked yet. No I/O, no React.

/** "Roti Jul 6 – 19" (or crossing months/years) across every week id given. */
export function settlementLabel(weekIds: string[]): string {
  const sorted = [...weekIds].sort();
  const first = parseYMD(sorted[0]);
  const last = parseYMD(sorted[sorted.length - 1]);
  last.setDate(last.getDate() + 6); // that week's Sunday
  const withYear = first.getFullYear() !== last.getFullYear();
  return `Roti ${dateRangeLabel(first, last, withYear)}`;
}

/** Canonical form for comparing Splitwise emails. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Display names of anyone holding a nonzero share with no saved Splitwise email. */
export function missingSplitwiseLinks(totals: PersonTotal[], users: User[]): string[] {
  return totals
    .filter((t) => !users.find((u) => u.id === t.userId)?.splitwise_email)
    .map((t) => cap(users.find((u) => u.id === t.userId)?.name ?? "unknown"));
}

/** One person's row in the push request the edge function expects. */
export interface SplitwisePerson {
  name: string;
  email: string;
  qty: number;
  amount: number;
}

/** Build the edge function's `people[]` payload, or null if anyone with a
 * share isn't linked — the caller should treat null as "block the push." */
export function buildSplitwisePeople(
  totals: PersonTotal[],
  users: User[],
): SplitwisePerson[] | null {
  if (missingSplitwiseLinks(totals, users).length > 0) return null;
  return totals.map((t) => {
    const user = users.find((u) => u.id === t.userId)!;
    return { name: user.name, email: user.splitwise_email!, qty: t.qty, amount: t.amount };
  });
}
