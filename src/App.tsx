import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import type { Entry } from "./types";
import type { ShareInput } from "./lib/split";
import * as db from "./lib/db";
import { getDeviceId } from "./lib/device";
import { cap, dayLabel, money, todayStr, weekIdOf } from "./lib/util";
import { useAuth } from "./hooks/useAuth";
import { useKhataData } from "./hooks/useKhataData";
import { useToast } from "./hooks/useToast";
import { useConfirm } from "./hooks/useConfirm";
import { BootScreen } from "./components/BootScreen";
import { Gate } from "./components/Gate";
import { Header } from "./components/Header";
import { TabSwitcher } from "./components/TabSwitcher";
import { OfflineBanner } from "./components/OfflineBanner";
import { ToPayCard } from "./components/ToPayCard";
import { AddForm } from "./components/AddForm";
import { WeekCard } from "./components/WeekCard";
import { PaidHistory } from "./components/PaidHistory";
import { EditSheet } from "./components/EditSheet";
import { LogView } from "./components/LogView";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { StatsSheet } from "./components/StatsSheet";
import { PeopleSheet } from "./components/PeopleSheet";
import { Toast } from "./components/Toast";
import { Roti } from "./components/icons";

const ENTRY_CODE = import.meta.env.VITE_ENTRY_CODE;

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
    input: { qty: number; rate: number; note: string; shares: ShareInput[] },
    date: string,
  ): Promise<boolean> {
    if (!user) return false;
    const weekId = weekIdOf(date);
    const isToday = date === todayStr();
    return withBusy(async () => {
      await db.addEntry(weekId, date, input, user, device);
      flash(`${isToday ? "Today" : dayLabel(date)} logged`);
    });
  }

  async function handleSaveEdit(
    entry: Entry,
    input: { qty: number; rate: number; note: string; shares: ShareInput[] },
  ) {
    if (!user) return;
    await withBusy(async () => {
      await db.editEntry(entry, { ...input, note: input.note.trim() }, user, device);
      setEditing(null);
      flash("Entry updated");
    });
  }

  async function handleDeleteEntry(entry: Entry) {
    if (!user) return;
    await withBusy(async () => {
      await db.deleteEntry(entry, user, device);
      setEditing(null);
      flash("Entry deleted");
    });
  }

  async function handleMarkPaid(weekId: string, paid: boolean) {
    if (!user) return;
    await withBusy(async () => {
      await db.setPaid(weekId, paid, user, device);
      flash(paid ? "Marked paid" : "Reopened");
    });
  }

  async function handleSettleAll() {
    if (!user) return;
    const ids = unpaid.map((w) => w.week_start);
    await withBusy(async () => {
      await db.settleAll(ids, user, device);
      flash("All weeks settled");
    });
  }

  function handleSignOut() {
    signOut();
    setTab("ledger");
  }

  function exportJSON() {
    const payload = { exported_at: new Date().toISOString(), weeks, entries, logs };
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
      const clean = name.trim().toLowerCase();
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
                  body:
                    "Marks all " +
                    unpaid.length +
                    " unpaid weeks paid — " +
                    money(owed) +
                    " total.",
                  cta: "Mark all paid",
                  tone: "go",
                  onYes: handleSettleAll,
                })
              }
            />

            <AddForm entries={entries} weeks={weeks} users={users} busy={busy} onAdd={handleAdd} />

            {shown.length === 0 ? (
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
                            body: "Entries will be locked. You can reopen it later if needed.",
                            cta: "Mark paid",
                            tone: "go",
                            onYes: () => handleMarkPaid(w.week_start, true),
                          })
                        }
                        onReopen={() => {}}
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
                  onExpand={loadHistory}
                  onReopen={(weekId) =>
                    setConfirm({
                      title: "Reopen this week?",
                      body: "It will go back to unpaid so entries can be edited. It re-joins your total.",
                      cta: "Reopen",
                      tone: "plain",
                      onYes: () => handleMarkPaid(weekId, false),
                    })
                  }
                />
              </>
            )}
            <div className="foot">
              {unpaid.length} open{paidCount > 0 ? ` \u00b7 ${paidCount} paid` : ""}
              {" \u00b7 "}
              <button
                className="foot-link"
                onClick={async () => {
                  if (!historyLoaded) await loadHistory();
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
