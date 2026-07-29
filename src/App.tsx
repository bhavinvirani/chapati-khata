import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import type { Entry, WeekView } from "./types";
import type { ShareInput } from "./lib/split";
import * as db from "./lib/db";
import { getDeviceId } from "./lib/device";
import { asAdd, describeAdd, describeEdit } from "./lib/logtext";
import { cap, dayLabel, money, normalizeName, round2, todayStr, weekIdOf } from "./lib/util";
import {
  buildSplitwisePeople,
  missingSplitwiseLinks,
  settlementDateRange,
  settlementLabel,
} from "./lib/splitwise";
import { perPerson } from "./lib/aggregate";
import { useAuth } from "./hooks/useAuth";
import { useKhataData } from "./hooks/useKhataData";
import { useToast } from "./hooks/useToast";
import { useConfirm } from "./hooks/useConfirm";
import { BootScreen } from "./components/BootScreen";
import { Gate } from "./components/Gate";
import { Header } from "./components/Header";
import { TabSwitcher } from "./components/TabSwitcher";
import { OfflineBanner } from "./components/OfflineBanner";
import { InstallPrompt } from "./components/InstallPrompt";
import { ToPayCard } from "./components/ToPayCard";
import { AddForm } from "./components/AddForm";
import { WeekCard } from "./components/WeekCard";
import { PaidHistory } from "./components/PaidHistory";
import { EditSheet } from "./components/EditSheet";
import { LogView } from "./components/LogView";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { StatsSheet } from "./components/StatsSheet";
import { SettleSummary } from "./components/SettleSummary";
import { PushSummary } from "./components/PushSummary";
import { PeopleSheet } from "./components/PeopleSheet";
import { Toast } from "./components/Toast";
import { Roti } from "./components/icons";

const ENTRY_CODE = import.meta.env.VITE_ENTRY_CODE;

/**
 * Turn a failed push's `error`/`detail` into a message naming exactly who
 * failed and why (design §13), instead of one generic string covering
 * "someone left the group," "Splitwise rejected the request," "the app
 * isn't configured yet," and a genuine network blip alike.
 */
function pushErrorMessage(result: { error?: string; detail?: string }): string {
  switch (result.error) {
    case "not_linked":
      return result.detail
        ? `${result.detail} not linked to Splitwise.`
        : "Someone isn't linked to Splitwise.";
    case "already_pushed":
      return "Someone else already pushed this — check Splitwise before retrying.";
    case "amount_mismatch":
      return "The amounts didn't add up — nothing was pushed. Try again.";
    case "config":
      return "Splitwise isn't configured yet.";
    case "splitwise":
      return "Splitwise rejected the request. Check the amounts and try again.";
    default:
      return "Splitwise push failed. Try again.";
  }
}

export default function App() {
  const { user, signIn, signOut, restoreUser } = useAuth();
  const {
    weeks,
    entries,
    users,
    allEntries,
    logs,
    loading,
    offline,
    checking,
    load,
    markOffline,
    hasMoreLogs,
    loadingMore,
    loadMoreLogs,
    loadingHistory,
    historyLoaded,
    loadHistory,
    shown,
    unpaid,
    paid,
    paidCount,
    owed,
    owedQty,
  } = useKhataData(restoreUser);
  const { toast, flash } = useToast();
  const { confirm, setConfirm, clearConfirm } = useConfirm();

  const [tab, setTab] = useState<"ledger" | "log">("ledger");
  const [editing, setEditing] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const busyRef = useRef(false);
  const pushPayerRef = useRef<string | null>(null);

  const device = useMemo(() => getDeviceId(), []);

  // ── action helpers ──

  const withBusy = useCallback(
    async (fn: () => Promise<void>): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        await fn();
        await load();
        return true;
      } catch {
        markOffline();
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [load, markOffline],
  );

  async function handleAdd(
    input: { qty: number; rate: number; otherQty: number; note: string; shares: ShareInput[] },
    date: string,
  ): Promise<boolean> {
    if (!user) return false;
    const weekId = weekIdOf(date);
    const isToday = date === todayStr();
    return withBusy(async () => {
      await db.addEntry(weekId, date, input, user, device, describeAdd(input, users));
      flash(`${isToday ? "Today" : dayLabel(date)} logged`);
    });
  }

  async function handleSaveEdit(
    entry: Entry,
    input: { qty: number; rate: number; otherQty: number; note: string; shares: ShareInput[] },
  ) {
    if (!user) return;
    await withBusy(async () => {
      await db.editEntry(
        entry,
        { ...input, note: input.note.trim() },
        user,
        device,
        describeEdit(asAdd(entry), input, users),
      );
      setEditing(null);
      flash("Entry updated");
    });
  }

  async function handleDeleteEntry(entry: Entry) {
    if (!user) return;
    await withBusy(async () => {
      await db.deleteEntry(entry, user, device, describeAdd(asAdd(entry), users));
      setEditing(null);
      flash("Entry deleted");
    });
  }

  async function handleMarkPaid(weekId: string) {
    if (!user) return;
    await withBusy(async () => {
      await db.createSettlement([weekId], user, device);
      flash("Marked paid");
    });
  }

  async function handleReopen(w: WeekView) {
    if (!user) return;
    await withBusy(async () => {
      try {
        await db.reopenWeek(w, user, device);
        flash("Reopened");
      } catch (e) {
        flash(e instanceof Error ? e.message : "Could not reopen.");
      }
    });
  }

  function handlePush(w: WeekView) {
    if (!user || !w.settlement) return;
    const settlementId = w.settlement.id;
    const weekIds = shown.filter((x) => x.settlement?.id === settlementId).map((x) => x.week_start);
    const settlementEntries = allEntries.filter((e) => weekIds.includes(e.week_start));
    const totals = perPerson(settlementEntries);
    const missing = missingSplitwiseLinks(totals, users);
    if (missing.length > 0) {
      flash(
        `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} linked to Splitwise yet.`,
      );
      return;
    }

    const people = buildSplitwisePeople(totals, users);
    if (!people) return; // unreachable given the check above; keeps TS satisfied

    const linkedPeople = users.filter((u) => u.splitwise_email);
    const defaultPayer = linkedPeople.find((u) => u.name === user) ?? null;
    pushPayerRef.current = defaultPayer?.id ?? null;

    const totalCost = round2(settlementEntries.reduce((sum, e) => sum + e.amount, 0));
    const description = settlementLabel(weekIds);
    const isRetry = w.settlement.splitwise_status === "unknown";

    setConfirm({
      title: isRetry ? "Retry pushing to Splitwise?" : "Push to Splitwise?",
      body: isRetry
        ? "The last attempt's outcome is unknown — it may already have been created. Check Splitwise before retrying to avoid a duplicate."
        : `Creating "${description}" for ${money(totalCost)}.`,
      detail: (
        <PushSummary
          entries={settlementEntries}
          users={users}
          weekIds={weekIds}
          payerOptions={linkedPeople}
          defaultPayerId={defaultPayer?.id ?? null}
          onPayerChange={(id) => {
            pushPayerRef.current = id;
          }}
          onError={flash}
        />
      ),
      cta: isRetry ? "Retry push" : "Push",
      tone: "go",
      onYes: () => {
        const payer = users.find((u) => u.id === pushPayerRef.current);
        withBusy(async () => {
          if (!payer) {
            flash("Choose who paid first.");
            return;
          }
          const result = await db.pushSettlement(
            settlementId,
            payer,
            people,
            totalCost,
            description,
            todayStr(),
            user,
            device,
            weekIds,
          );
          if (result.ok) flash("Pushed to Splitwise");
          else if (result.status === "unknown")
            flash("Could not confirm the push landed — check Splitwise.");
          else flash(pushErrorMessage(result));
        });
      },
    });
  }

  function confirmReopen(w: WeekView) {
    const settlement = w.settlement;
    const siblingWeeks = settlement ? shown.filter((x) => x.settlement?.id === settlement.id) : [w];
    const pushed = !!settlement?.splitwise_expense_id;
    const uncertain = settlement?.splitwise_status === "unknown";
    const parts = [
      siblingWeeks.length > 1
        ? `This will reopen every week settled together with it (${settlementDateRange(siblingWeeks.map((x) => x.week_start))}).`
        : "It will go back to unpaid so entries can be edited.",
    ];
    if (pushed) parts.push("It will also be removed from Splitwise first.");
    else if (uncertain)
      parts.push(
        "The last push attempt's outcome was never confirmed — check Splitwise for a possible existing expense before reopening, since reopening will not be able to find or remove it afterward.",
      );
    setConfirm({
      title: "Reopen this week?",
      body: parts.join(" "),
      cta: "Reopen",
      tone: "plain",
      onYes: () => handleReopen(w),
    });
  }

  async function handleSettleAll() {
    if (!user) return;
    const ids = unpaid.map((w) => w.week_start);
    await withBusy(async () => {
      await db.createSettlement(ids, user, device);
      flash("All weeks settled");
    });
  }

  function handleSignOut() {
    signOut();
    setTab("ledger");
  }

  // `entries` holds unpaid weeks only, and `allEntries` is captured from the
  // render this closure was created in — so it cannot see what loadHistory
  // just fetched. Use what loadHistory returns instead.
  async function exportJSON() {
    let paid: Entry[];
    try {
      paid = await loadHistory();
    } catch {
      // A partial backup that looks complete is worse than no backup — bail
      // out without writing anything.
      flash("Could not back up. Check your connection.");
      return;
    }
    const payload = {
      exported_at: new Date().toISOString(),
      weeks,
      users,
      entries: [...entries, ...paid],
      logs,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chapati-khata-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flash("Backup downloaded");
  }

  // ── render ──

  if (checking) return <BootScreen />;

  if (!user) {
    const handleGateSubmit = async (
      name: string,
      code: string,
    ): Promise<"name" | "code" | "network" | null> => {
      const clean = normalizeName(name);
      if (ENTRY_CODE) {
        // Local dev: code from .env, name from the users table
        if (code !== ENTRY_CODE) return "code";
        if (!(await db.nameCanLogin(clean))) return "name";
      } else {
        // Production: validate via edge function
        try {
          const result = await db.validateAccess(clean, code);
          if (!result.ok) return (result.error as "code" | "name") ?? "code";
        } catch {
          return "network";
        }
      }
      signIn(clean);
      db.logLogin(clean, device).catch(() => {});
      load();
      return null;
    };
    return (
      <div className="khata">
        <Gate onSubmit={handleGateSubmit} />
      </div>
    );
  }

  return (
    <div className="khata">
      <div className="shell">
        <Header
          loading={loading}
          userName={user}
          onExport={exportJSON}
          onRefresh={load}
          onPeopleClick={() => setShowPeople(true)}
          onUserClick={() =>
            setConfirm({
              title: "Signed in as " + cap(user),
              body: "You'll need to sign in again with your name and access code.",
              cta: "Log out",
              tone: "plain",
              onYes: handleSignOut,
            })
          }
        />

        <TabSwitcher tab={tab} onTabChange={setTab} />

        {offline && <OfflineBanner onRetry={load} />}

        <InstallPrompt />

        {tab === "ledger" ? (
          <main className="scroll">
            <ToPayCard
              owed={owed}
              owedQty={owedQty}
              unpaid={unpaid}
              busy={busy}
              onSettle={() =>
                setConfirm({
                  title: "Settle every open week?",
                  body: `Paying ${money(owed)} across ${unpaid.length} weeks. Here is what makes it up — entries lock once paid, and you can reopen later.`,
                  detail: (
                    <SettleSummary
                      entries={unpaid.flatMap((wk) => wk.entries)}
                      users={users}
                      weekIds={unpaid.map((wk) => wk.week_start)}
                      onError={flash}
                    />
                  ),
                  cta: "Mark all paid",
                  tone: "go",
                  onYes: handleSettleAll,
                })
              }
            />

            <AddForm entries={entries} weeks={weeks} users={users} busy={busy} onAdd={handleAdd} />

            {shown.length === 0 && paidCount === 0 ? (
              <div className="empty">
                <Roti size={40} />
                <p>No records yet.</p>
                <span>Add today's chapatis above and the week will appear here.</span>
              </div>
            ) : (
              <>
                {unpaid.map((w, i) => {
                  const prevYear = i > 0 ? unpaid[i - 1].week_start.slice(0, 4) : null;
                  const year = w.week_start.slice(0, 4);
                  return (
                    <Fragment key={w.week_start}>
                      {prevYear && year !== prevYear && <div className="year-sep">{year}</div>}
                      <WeekCard
                        w={w}
                        users={users}
                        busy={busy}
                        onEntry={(entry) => setEditing(entry)}
                        onDiscard={(entry) =>
                          setConfirm({
                            title: "Discard this add?",
                            body: "It was never fully split. Discarding removes it, and its money, from the week. This cannot be undone.",
                            cta: "Discard",
                            tone: "plain",
                            onYes: () => handleDeleteEntry(entry),
                          })
                        }
                        onPay={() =>
                          setConfirm({
                            title: "Mark this week paid?",
                            body: `Paying ${money(w.total)}. Here is what makes it up — entries lock once paid, and you can reopen later.`,
                            detail: (
                              <SettleSummary
                                entries={w.entries}
                                users={users}
                                weekIds={[w.week_start]}
                                onError={flash}
                              />
                            ),
                            cta: "Mark paid",
                            tone: "go",
                            onYes: () => handleMarkPaid(w.week_start),
                          })
                        }
                        onPush={() => handlePush(w)}
                        onReopen={() => confirmReopen(w)}
                        onError={flash}
                      />
                    </Fragment>
                  );
                })}

                <PaidHistory
                  paidCount={paidCount}
                  historyLoaded={historyLoaded}
                  loadingHistory={loadingHistory}
                  paid={paid}
                  users={users}
                  busy={busy}
                  onExpand={() => {
                    // Deliberately quiet: toggling the section open on a bad
                    // connection should not throw at the user. `loadHistory`
                    // now rethrows for callers that need to know (the
                    // export), so this call site owns its own catch.
                    loadHistory().catch(() => {});
                  }}
                  onReopen={(weekId) => {
                    const w = paid.find((x) => x.week_start === weekId);
                    if (w) confirmReopen(w);
                  }}
                  onPush={(w) => handlePush(w)}
                  onError={flash}
                />
              </>
            )}
            <div className="foot">
              {unpaid.length} open{paidCount > 0 ? ` \u00b7 ${paidCount} paid` : ""}
              {" \u00b7 "}
              <button
                className="foot-link"
                onClick={async () => {
                  // Same quiet-catch reasoning as the Paid history expander:
                  // opening Stats should not throw at the user if the fetch
                  // fails, just proceed with whatever is loaded.
                  if (!historyLoaded) await loadHistory().catch(() => {});
                  setShowStats(true);
                }}
              >
                Stats
              </button>
            </div>
          </main>
        ) : (
          <LogView
            logs={logs}
            hasMore={hasMoreLogs}
            loadingMore={loadingMore}
            onLoadMore={loadMoreLogs}
          />
        )}
      </div>

      {editing && (
        <EditSheet
          entry={editing}
          users={users}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={handleSaveEdit}
          onDelete={handleDeleteEntry}
        />
      )}

      {confirm && <ConfirmDialog confirm={confirm} busy={busy} onClose={clearConfirm} />}

      {showStats && (
        <StatsSheet entries={allEntries} users={users} onClose={() => setShowStats(false)} />
      )}

      {showPeople && user && (
        <PeopleSheet
          users={users}
          actor={user}
          busy={busy}
          deviceId={device}
          onClose={() => setShowPeople(false)}
          onChanged={load}
          onError={flash}
        />
      )}

      {toast && <Toast message={toast} />}
    </div>
  );
}
