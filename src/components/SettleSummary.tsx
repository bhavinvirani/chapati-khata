import type { Entry, User } from "../types";
import { nameOf, otherQty, perPerson } from "../lib/aggregate";
import { cap, money, round2, weekLabel } from "../lib/util";

interface Props {
  /** Every add being settled by this action. */
  entries: Entry[];
  users: User[];
  /** Week ids covered, so the summary can say what period this payment is for. */
  weekIds: string[];
}

const CURRENT_YEAR = String(new Date().getFullYear());

/**
 * The last look before money changes hands: for the amount about to be paid,
 * who ate how much of it, and over which days.
 *
 * Deliberately the same figures the ledger already shows, recomputed from the
 * same stored shares rather than passed in — a confirmation that trusted a
 * number computed elsewhere could confirm the wrong one.
 */
export function SettleSummary({ entries, users, weekIds }: Props) {
  const people = perPerson(entries);
  const guests = otherQty(entries);
  const totalQty = entries.reduce((sum, e) => sum + e.qty, 0);
  const totalAmount = round2(entries.reduce((sum, e) => sum + e.amount, 0));
  const days = new Set(entries.map((e) => e.day)).size;

  const weeks = [...weekIds].sort();
  const spansYears = weeks.some((w) => w.slice(0, 4) !== CURRENT_YEAR);

  return (
    <div className="settle">
      <div className="settle-when">
        {weeks.map((w) => weekLabel(w, spansYears)).join(" · ")}
        <span className="settle-days">
          {days} day{days !== 1 ? "s" : ""}
        </span>
      </div>

      <ul className="share-rows">
        {people.map((p) => (
          <li key={p.userId} className="share-row">
            <span className="share-name">{cap(nameOf(users, p.userId))}</span>
            <span className="share-qty">{p.qty}</span>
            <span className="share-amt">{money(p.amount)}</span>
          </li>
        ))}
        {guests > 0 && (
          <li className="share-row share-other">
            <span className="share-name">Others</span>
            <span className="share-qty">{guests}</span>
            <span className="share-amt" />
          </li>
        )}
      </ul>

      <div className="settle-total">
        <span className="share-name">Total</span>
        <span className="share-qty">{totalQty}</span>
        <span className="share-amt">{money(totalAmount)}</span>
      </div>
    </div>
  );
}
