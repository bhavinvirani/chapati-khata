import React, { useMemo, useState } from "react";
import type { Entry } from "./types";
import type { ParsedQty } from "./lib/util";
import * as db from "./lib/db";
import { getDeviceId } from "./lib/device";
import { cap, dayLabel, money, todayStr, weekIdOf } from "./lib/util";
import { ALLOWED_NAMES } from "./config";
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
import { Toast } from "./components/Toast";
import { Roti } from "./components/icons";

const ENTRY_CODE = import.meta.env.VITE_ENTRY_CODE as string | undefined;

export default function App() {
  const { user, signIn, signOut, restoreUser } = useAuth();
  const {
    weeks, entries, logs,
    loading, offline, checking,
    load, markOffline,
    hasMoreLogs, loadingMore, loadMoreLogs,
    loadingHistory, historyLoaded, loadHistory,
    shown, unpaid, paid, paidCount, owed, owedQty,
  } = useKhataData(restoreUser);
  const { toast, flash } = useToast();
  const { confirm, setConfirm, clearConfirm } = useConfirm();

  const [tab, setTab] = useState<"ledger" | "log">("ledger");
  const [editing, setEditing] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);

  const device = useMemo(() => getDeviceId(), []);

  // ── action helpers ──

  async function withBusy(fn: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      await fn();
      await load();
      return true;
    } catch {
      markOffline();
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(parsed: ParsedQty, note: string, date: string): Promise<boolean> {
    if (!user) return false;
    const weekId = weekIdOf(date);
    const existing = entries.find((e) => e.day === date) ?? null;
    const wasThere = !!existing;
    const isToday = date === todayStr();
    return withBusy(async () => {
      await db.addToday(weekId, date, { qty: parsed.qty, price: parsed.price, note }, existing, user, device);
      flash(wasThere
        ? `Added to ${isToday ? "today" : dayLabel(date)}`
        : `${isToday ? "Today" : dayLabel(date)} logged`);
    });
  }

  async function handleSaveEdit(entry: Entry, qty: number, note: string) {
    if (!user) return;
    await withBusy(async () => {
      await db.editEntry(entry, qty, note.trim(), user, device);
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
    const handleGateSubmit = async (name: string, code: string): Promise<"name" | "code" | "network" | null> => {
      const clean = name.trim().toLowerCase();
      if (ENTRY_CODE) {
        // Local dev: validate from .env + config.ts
        if (code !== ENTRY_CODE) return "code";
        if (!ALLOWED_NAMES.includes(clean)) return "name";
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
                  body: "Marks all " + unpaid.length + " unpaid weeks paid — " + money(owed) + " total.",
                  cta: "Mark all paid",
                  tone: "go",
                  onYes: handleSettleAll,
                })
              }
            />

            <AddForm
              entries={entries}
              weeks={weeks}
              busy={busy}
              onAdd={handleAdd}
            />

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
                    <React.Fragment key={w.week_start}>
                      {prevYear && year !== prevYear && <div className="year-sep">{year}</div>}
                      <WeekCard
                        w={w}
                        busy={busy}
                        onEntry={(entry) => setEditing(entry)}
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
                    </React.Fragment>
                  );
                })}

                <PaidHistory
                  paidCount={paidCount}
                  historyLoaded={historyLoaded}
                  loadingHistory={loadingHistory}
                  paid={paid}
                  busy={busy}
                  onExpand={loadHistory}
                  onEntry={(entry) => setEditing(entry)}
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
            <div className="foot">Shared tab &middot; {unpaid.length} open{paidCount > 0 ? ` \u00b7 ${paidCount} paid` : ""}</div>
          </main>
        ) : (
          <LogView logs={logs} hasMore={hasMoreLogs} loadingMore={loadingMore} onLoadMore={loadMoreLogs} />
        )}
      </div>

      {editing && (
        <EditSheet
          entry={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={handleSaveEdit}
          onDelete={handleDeleteEntry}
        />
      )}

      {confirm && <ConfirmDialog confirm={confirm} busy={busy} onClose={clearConfirm} />}

      {toast && <Toast message={toast} />}
    </div>
  );
}
