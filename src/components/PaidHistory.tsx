import { useState } from "react";
import type { Entry, WeekView } from "../types";
import { WeekCard } from "./WeekCard";

interface Props {
  paidCount: number;
  historyLoaded: boolean;
  loadingHistory: boolean;
  paid: WeekView[];
  busy: boolean;
  onExpand: () => void;
  onEntry: (entry: Entry) => void;
  onReopen: (weekId: string) => void;
}

export function PaidHistory({
  paidCount, historyLoaded, loadingHistory,
  paid, busy, onExpand, onEntry, onReopen,
}: Props) {
  const [open, setOpen] = useState(false);

  if (paidCount === 0) return null;

  function handleToggle() {
    const willOpen = !open;
    setOpen(willOpen);
    if (willOpen && !historyLoaded) {
      onExpand();
    }
  }

  return (
    <section className="history">
      <button className="history-toggle" onClick={handleToggle}>
        <span className="history-label">
          <span className={"history-arrow" + (open ? " open" : "")}>{"\u25B8"}</span>
          History &middot; {paidCount} week{paidCount !== 1 ? "s" : ""} paid
        </span>
      </button>
      {open && (
        loadingHistory ? (
          <div className="history-loading">Loading history&hellip;</div>
        ) : (
          <div className="history-weeks">
            {paid.map((w) => (
              <WeekCard
                key={w.week_start}
                w={w}
                busy={busy}
                onEntry={onEntry}
                onPay={() => {}}
                onReopen={() => onReopen(w.week_start)}
              />
            ))}
          </div>
        )
      )}
    </section>
  );
}
