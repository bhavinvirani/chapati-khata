import { Fragment, useState } from "react";
import type { User, WeekView } from "../types";
import { perPerson } from "../lib/aggregate";
import { missingSplitwiseLinks, settlementDateRange } from "../lib/splitwise";
import { money, round2 } from "../lib/util";
import { WeekCard } from "./WeekCard";
import { SplitwiseControl } from "./SplitwiseControl";
import { ReceiptButton } from "./ReceiptButton";

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
  onError: (msg: string) => void;
}

/**
 * Weeks paid together (same settlement) grouped in the order first seen,
 * each week paid alone forming its own group of one. This is what lets the
 * shared push/reopen action live in one place instead of being duplicated,
 * identically, on every week card that happens to share a settlement.
 */
function groupBySettlement(paid: WeekView[]): WeekView[][] {
  const groups: WeekView[][] = [];
  const bySettlement = new Map<string, WeekView[]>();
  for (const w of paid) {
    const key = w.settlement?.id ?? `week:${w.week_start}`;
    let group = bySettlement.get(key);
    if (!group) {
      group = [];
      bySettlement.set(key, group);
      groups.push(group);
    }
    group.push(w);
  }
  return groups;
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
  onError,
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

  const groups = groupBySettlement(paid);

  return (
    <section className="history">
      <button className="history-toggle" onClick={handleToggle}>
        <span className="history-label">
          <span className={"history-arrow" + (open ? " open" : "")}>{"▸"}</span>
          History &middot; {paidCount} week{paidCount !== 1 ? "s" : ""} paid
        </span>
      </button>
      {open &&
        (loadingHistory ? (
          <div className="history-loading">Loading history&hellip;</div>
        ) : (
          <div className="history-weeks">
            {groups.map((group, i) => {
              const prevYear = i > 0 ? groups[i - 1][0].week_start.slice(0, 4) : null;
              const year = group[0].week_start.slice(0, 4);
              const key = group[0].settlement?.id ?? group[0].week_start;
              const yearSep = prevYear && year !== prevYear && (
                <div className="year-sep">{year}</div>
              );

              if (group.length === 1) {
                const w = group[0];
                return (
                  <Fragment key={key}>
                    {yearSep}
                    <WeekCard
                      w={w}
                      users={users}
                      busy={busy}
                      onEntry={() => {}}
                      onDiscard={() => {}}
                      onPay={() => {}}
                      onPush={() => onPush(w)}
                      onReopen={() => onReopen(w.week_start)}
                      onError={onError}
                    />
                  </Fragment>
                );
              }

              const settlement = group[0].settlement;
              const groupEntries = group.flatMap((w) => w.entries);
              const missing = missingSplitwiseLinks(perPerson(groupEntries), users);
              const total = round2(group.reduce((sum, w) => sum + w.total, 0));
              const range = settlementDateRange(group.map((w) => w.week_start));

              return (
                <Fragment key={key}>
                  {yearSep}
                  <div className="settlement-group">
                    <div className="settlement-group-head">
                      <span className="settlement-group-label">
                        Settled together &middot; {range} &middot; {money(total)}
                      </span>
                      <div className="settlement-group-a">
                        <SplitwiseControl
                          settlement={settlement}
                          missing={missing}
                          busy={busy}
                          onPush={() => onPush(group[0])}
                        />
                        <ReceiptButton
                          entries={groupEntries}
                          weekIds={group.map((w) => w.week_start)}
                          onError={onError}
                        />
                        <button
                          className="link"
                          disabled={busy}
                          onClick={() => onReopen(group[0].week_start)}
                        >
                          Reopen
                        </button>
                      </div>
                    </div>
                    {group.map((w) => (
                      <WeekCard
                        key={w.week_start}
                        w={w}
                        users={users}
                        busy={busy}
                        onEntry={() => {}}
                        onDiscard={() => {}}
                        onPay={() => {}}
                        onPush={() => {}}
                        onReopen={() => {}}
                        onError={onError}
                        showActions={false}
                      />
                    ))}
                  </div>
                </Fragment>
              );
            })}
          </div>
        ))}
    </section>
  );
}
