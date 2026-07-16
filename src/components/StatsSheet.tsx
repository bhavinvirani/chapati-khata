import { useMemo, useState } from "react";
import type { Entry } from "../types";
import { money, round2 } from "../lib/util";
import { IcX } from "./icons";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  entries: Entry[];
  onClose: () => void;
}

export function StatsSheet({ entries, onClose }: Props) {
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.day.slice(0, 7));
    return [...set].sort().reverse();
  }, [entries]);

  const [idx, setIdx] = useState(0);
  const key = months[idx];

  const stats = useMemo(() => {
    if (!key) return null;
    const me = entries.filter((e) => e.day.slice(0, 7) === key);
    const qty = me.reduce((s, e) => s + e.qty, 0);
    const amt = round2(me.reduce((s, e) => s + e.amount, 0));
    const orderDays = new Set(me.map((e) => e.day)).size;
    const [y, m] = key.split("-").map(Number);
    const dim = new Date(y, m, 0).getDate();
    const weeksInMonth = dim / 7;

    // Avg orders per week = order days / weeks in month
    const ordersPerWeek = round2(orderDays / weeksInMonth);
    // Avg rotis per order = total qty / order days
    const rotisPerOrder = orderDays > 0 ? round2(qty / orderDays) : 0;
    // Effective rate
    const rate = qty > 0 ? round2(amt / qty) : 0;

    // Previous month comparison
    const pk = months[idx + 1];
    let pqty: number | null = null;
    if (pk) {
      pqty = entries.filter((e) => e.day.slice(0, 7) === pk).reduce((s, e) => s + e.qty, 0);
    }

    return {
      label: `${MONTHS[m - 1]} ${y}`,
      qty, amt, ordersPerWeek, rotisPerOrder, rate, pqty,
    };
  }, [entries, key, idx, months]);

  if (!stats) {
    return (
      <div className="ovl" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-grip" />
          <div className="sheet-head">
            <h3 className="sheet-t">Monthly Stats</h3>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <IcX className="ic" />
            </button>
          </div>
          <div className="stats-empty">No data yet.</div>
        </div>
      </div>
    );
  }

  const pct =
    stats.pqty != null && stats.pqty > 0
      ? Math.round(((stats.qty - stats.pqty) / stats.pqty) * 100)
      : null;

  return (
    <div className="ovl" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h3 className="sheet-t">Monthly Stats</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IcX className="ic" />
          </button>
        </div>

        <div className="stats-nav">
          <button
            className="stats-nav-btn"
            disabled={idx >= months.length - 1}
            onClick={() => setIdx((i) => i + 1)}
            aria-label="Previous month"
          >
            &lsaquo;
          </button>
          <span className="stats-month">{stats.label}</span>
          <button
            className="stats-nav-btn"
            disabled={idx <= 0}
            onClick={() => setIdx((i) => i - 1)}
            aria-label="Next month"
          >
            &rsaquo;
          </button>
        </div>

        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-val">{stats.qty}</div>
            <div className="stat-label">chapatis</div>
          </div>
          <div className="stat-card">
            <div className="stat-val stat-amt">{money(stats.amt)}</div>
            <div className="stat-label">spent</div>
          </div>
          <div className="stat-card">
            <div className="stat-val">{stats.ordersPerWeek}</div>
            <div className="stat-label">orders / week</div>
          </div>
          <div className="stat-card">
            <div className="stat-val">{stats.rotisPerOrder}</div>
            <div className="stat-label">rotis / order</div>
          </div>
          <div className="stat-card">
            <div className="stat-val stat-rate">{money(stats.rate)}</div>
            <div className="stat-label">per chapati</div>
          </div>
          <div className="stat-card">
            {pct != null ? (
              <>
                <div className={"stat-val " + (pct >= 0 ? "stat-up" : "stat-down")}>
                  {pct >= 0 ? "\u25B2" : "\u25BC"} {Math.abs(pct)}%
                </div>
                <div className="stat-label">vs prev month</div>
              </>
            ) : (
              <>
                <div className="stat-val stat-na">&mdash;</div>
                <div className="stat-label">vs prev month</div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
