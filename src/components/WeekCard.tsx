import type { Entry, WeekView } from "../types";
import { dayLabel, isCurrentWeek, money, stamp, weekLabel } from "../lib/util";
import { IcCheck, IcLock, IcPencil } from "./icons";

interface Props {
  w: WeekView;
  busy: boolean;
  onEntry: (entry: Entry) => void;
  onPay: () => void;
  onReopen: () => void;
}

export function WeekCard({ w, busy, onEntry, onPay, onReopen }: Props) {
  const rows = [...w.entries].sort((a, b) => (a.day < b.day ? 1 : -1));
  const showYear = w.week_start.slice(0, 4) !== String(new Date().getFullYear());

  return (
    <section className={"week" + (w.paid ? " paid" : "") + (isCurrentWeek(w.week_start) ? " now" : "")}>
      <div className="perf" />
      <div className="week-head">
        <div>
          <div className="week-range">
            {weekLabel(w.week_start, showYear)}
            {isCurrentWeek(w.week_start) && <span className="tag-now">this week</span>}
          </div>
          <div className="week-meta">
            <b>{money(w.total)}</b>
            <span className="dot">·</span>
            {w.count} chapati{w.count !== 1 ? "s" : ""}
          </div>
        </div>
        {w.paid ? (
          <span className="badge-paid">
            <IcCheck className="ic sm" />
            Paid
          </span>
        ) : (
          <button className="btn btn-pay" disabled={busy} onClick={onPay}>
            Mark paid
          </button>
        )}
      </div>

      <ul className="rows">
        {rows.map((e) => (
          <li
            key={e.id}
            className={"row" + (w.paid ? " locked" : "")}
            onClick={() => !w.paid && onEntry(e)}
            role={w.paid ? undefined : "button"}
            tabIndex={w.paid ? undefined : 0}
            onKeyDown={(ev) => {
              if (!w.paid && (ev.key === "Enter" || ev.key === " ")) {
                ev.preventDefault();
                onEntry(e);
              }
            }}
          >
            <div className="row-day">{dayLabel(e.day)}</div>
            <div className="row-mid">
              <span className="row-qty">{e.qty}</span>
              <span className="row-unit">chapati{e.qty !== 1 ? "s" : ""}</span>
              {e.note && <span className="row-note">{e.note}</span>}
            </div>
            <div className="row-amt">{money(e.amount)}</div>
            {!w.paid && <IcPencil className="row-edit" />}
          </li>
        ))}
      </ul>

      {w.paid && (
        <div className="week-foot">
          <span className="locked-note">
            <IcLock className="ic sm" />
            Locked{w.paid_at ? ` · paid ${stamp(w.paid_at)}` : ""}
          </span>
          <button className="link" disabled={busy} onClick={onReopen}>
            Reopen
          </button>
        </div>
      )}
    </section>
  );
}
