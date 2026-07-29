import { useState } from "react";
import type { Entry, User, WeekView } from "../types";
import { groupByDay, nameOf, needsRepair, otherQty, perPerson } from "../lib/aggregate";
import { missingSplitwiseLinks } from "../lib/splitwise";
import { cap, dayLabel, isCurrentWeek, money, stamp, weekLabel } from "../lib/util";
import { IcCheck, IcLock, IcPencil } from "./icons";
import { ReceiptButton } from "./ReceiptButton";
import { SplitwiseControl } from "./SplitwiseControl";

interface Props {
  w: WeekView;
  users: User[];
  busy: boolean;
  onEntry: (entry: Entry) => void;
  onDiscard: (entry: Entry) => void;
  onPay: () => void;
  onReopen: () => void;
  onPush: () => void;
  onError: (msg: string) => void;
  /** False when this card is rendered inside a multi-week settlement group
   * (PaidHistory), which shows one shared Push/Pushed/Reopen control for the
   * whole group instead of duplicating it on every member card. */
  showActions?: boolean;
}

const CURRENT_YEAR = String(new Date().getFullYear());

export function WeekCard({
  w,
  users,
  busy,
  onEntry,
  onDiscard,
  onPay,
  onReopen,
  onPush,
  onError,
  showActions = true,
}: Props) {
  const [openAdd, setOpenAdd] = useState<string | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const days = groupByDay(w.entries);
  const people = perPerson(w.entries);
  const weekOther = otherQty(w.entries);
  const missing = missingSplitwiseLinks(people, users);
  const showYear = w.week_start.slice(0, 4) !== CURRENT_YEAR;

  return (
    <section
      className={"week" + (w.paid ? " paid" : "") + (isCurrentWeek(w.week_start) ? " now" : "")}
    >
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
        {days.map((d) => (
          <li key={d.day} className="day">
            <button
              className="day-head"
              onClick={() => setOpenDay(openDay === d.day ? null : d.day)}
              aria-expanded={openDay === d.day}
            >
              <span className="row-day">{dayLabel(d.day)}</span>
              <span className="day-tot">
                {d.qty} chapati{d.qty !== 1 ? "s" : ""}
              </span>
              <span className="row-amt">{money(d.amount)}</span>
            </button>

            {openDay === d.day && (
              <ul className="share-rows day-people">
                {perPerson(d.adds).map((pp) => (
                  <li key={pp.userId} className="share-row">
                    <span className="share-name">{cap(nameOf(users, pp.userId))}</span>
                    <span className="share-qty">{pp.qty}</span>
                    <span className="share-amt">{money(pp.amount)}</span>
                  </li>
                ))}
                {otherQty(d.adds) > 0 && (
                  <li className="share-row share-other">
                    <span className="share-name">Others</span>
                    <span className="share-qty">{otherQty(d.adds)}</span>
                    <span className="share-amt" />
                  </li>
                )}
              </ul>
            )}

            {d.adds.map((e) => {
              const broken = needsRepair(e);
              const open = openAdd === e.id;
              return (
                <div key={e.id} className={"add-line" + (broken ? " broken" : "")}>
                  <button
                    className="add-line-main"
                    onClick={() => setOpenAdd(open ? null : e.id)}
                    aria-expanded={!broken && open}
                  >
                    <span className="add-line-qty">
                      {e.qty} @ {money(e.rate)}
                    </span>
                    {e.note && <span className="row-note">{e.note}</span>}
                    <span className="row-amt">{money(e.amount)}</span>
                  </button>

                  {!w.paid && (
                    <button
                      className="icon-btn add-line-edit"
                      onClick={() => onEntry(e)}
                      aria-label="Edit this add"
                    >
                      <IcPencil className="ic sm" />
                    </button>
                  )}

                  {/* Repairing changes the add's qty and amount, so on a paid
                      week it would move a total already handed to the shop.
                      Say what is wrong either way; offer the actions only
                      while the week is still open. */}
                  {broken && w.paid && (
                    <div className="repair">
                      <span>This add was not fully split. Reopen the week to fix it.</span>
                    </div>
                  )}

                  {broken && !w.paid && (
                    <div className="repair">
                      <span>This add was not fully split.</span>
                      <div className="repair-a">
                        <button className="link" disabled={busy} onClick={() => onEntry(e)}>
                          Finish split
                        </button>
                        <button
                          className="link danger"
                          disabled={busy}
                          onClick={() => onDiscard(e)}
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  )}

                  {open && !broken && (
                    <ul className="share-rows">
                      {e.entry_shares.map((s) => (
                        <li key={s.user_id} className="share-row">
                          <span className="share-name">{cap(nameOf(users, s.user_id))}</span>
                          <span className="share-qty">{s.qty}</span>
                          <span className="share-amt">{money(s.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </li>
        ))}
      </ul>

      {(people.length > 0 || weekOther > 0) && (
        <div className="week-people">
          <div className="week-people-t">Per person this week</div>
          <ul className="share-rows">
            {people.map((p) => (
              <li key={p.userId} className="share-row">
                <span className="share-name">{cap(nameOf(users, p.userId))}</span>
                <span className="share-qty">{p.qty}</span>
                <span className="share-amt">{money(p.amount)}</span>
              </li>
            ))}
            {weekOther > 0 && (
              <li className="share-row share-other">
                <span className="share-name">Others</span>
                <span className="share-qty">{weekOther}</span>
                <span className="share-amt" />
              </li>
            )}
          </ul>
        </div>
      )}

      {w.paid && (
        <div className="week-foot">
          <span className="locked-note">
            <IcLock className="ic sm" />
            Locked{w.paid_at ? ` · paid ${stamp(w.paid_at)}` : ""}
          </span>
          {showActions && (
            <div className="week-foot-a">
              <SplitwiseControl
                settlement={w.settlement}
                missing={missing}
                busy={busy}
                onPush={onPush}
              />
              <ReceiptButton entries={w.entries} weekIds={[w.week_start]} onError={onError} />
              <button className="link" disabled={busy} onClick={onReopen}>
                Reopen
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
