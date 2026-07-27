import { Fragment, useState } from "react";
import type { User, WeekView } from "../types";
import { WeekCard } from "./WeekCard";

interface Props {
  paidCount: number;
  historyLoaded: boolean;
  loadingHistory: boolean;
  paid: WeekView[];
  users: User[];
  busy: boolean;
  onExpand: () => void;
  onReopen: (weekId: string) => void;
  onPush: (w: WeekView) => void;
}

export function PaidHistory({
  paidCount,
  historyLoaded,
  loadingHistory,
  paid,
  users,
  busy,
  onExpand,
  onReopen,
  onPush,
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
      {open &&
        (loadingHistory ? (
          <div className="history-loading">Loading history&hellip;</div>
        ) : (
          <div className="history-weeks">
            {paid.map((w, i) => {
              const prevYear = i > 0 ? paid[i - 1].week_start.slice(0, 4) : null;
              const year = w.week_start.slice(0, 4);
              return (
                <Fragment key={w.week_start}>
                  {prevYear && year !== prevYear && <div className="year-sep">{year}</div>}
                  <WeekCard
                    w={w}
                    users={users}
                    busy={busy}
                    onEntry={() => {}}
                    onDiscard={() => {}}
                    onPay={() => {}}
                    onPush={() => onPush(w)}
                    onReopen={() => onReopen(w.week_start)}
                  />
                </Fragment>
              );
            })}
          </div>
        ))}
    </section>
  );
}
