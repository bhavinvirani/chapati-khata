import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, LogRow, Week, WeekView } from "./types";
import { ALLOWED_NAMES } from "./config";
import * as db from "./lib/db";
import { ensureAuth } from "./lib/supabase";
import { getDeviceId } from "./lib/device";
import { cap, dayLabel, money, parseQty, round2, todayStr, weekIdOf } from "./lib/util";
import { IcCheck, IcDownload, IcPlus, IcRefresh, IcX, Roti } from "./components/icons";
import { Gate } from "./components/Gate";
import { WeekCard } from "./components/WeekCard";
import { EditSheet } from "./components/EditSheet";
import { LogView } from "./components/LogView";

interface Confirm {
  title: string;
  body: string;
  cta: string;
  tone: "go" | "plain";
  onYes: () => void;
}

export default function App() {
  const [user, setUser] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);

  const [weeks, setWeeks] = useState<Week[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<"ledger" | "log">("ledger");
  const [editing, setEditing] = useState<Entry | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [qtyRaw, setQtyRaw] = useState("");
  const [noteRaw, setNoteRaw] = useState("");
  const [addErr, setAddErr] = useState("");

  const device = useMemo(() => getDeviceId(), []);
  const toastTimer = useRef<number | null>(null);
  const flash = (m: string) => {
    setToast(m);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await db.loadAll();
      setWeeks(data.weeks);
      setEntries(data.entries);
      setLogs(data.logs);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // auth gate + remember name + first load
  useEffect(() => {
    (async () => {
      try {
        await ensureAuth();
        const saved = localStorage.getItem("khata.name");
        if (saved && ALLOWED_NAMES.includes(saved)) setUser(saved);
        setReady(true);
        await load();
      } catch {
        setOffline(true);
      } finally {
        setChecking(false);
      }
    })();
  }, [load]);

  // realtime + refresh on focus (once authed)
  useEffect(() => {
    if (!ready) return;
    const unsub = db.subscribeChanges(() => load());
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ready, load]);

  // ── derived ──
  const weekViews: WeekView[] = useMemo(() => {
    const byWeek = new Map<string, Entry[]>();
    for (const e of entries) {
      const arr = byWeek.get(e.week_start) ?? [];
      arr.push(e);
      byWeek.set(e.week_start, arr);
    }
    const paidMap = new Map(weeks.map((w) => [w.week_start, w]));
    const ids = new Set<string>([...weeks.map((w) => w.week_start), ...entries.map((e) => e.week_start)]);
    const views: WeekView[] = [];
    ids.forEach((id) => {
      const es = byWeek.get(id) ?? [];
      const wk = paidMap.get(id);
      views.push({
        week_start: id,
        paid: wk?.paid ?? false,
        paid_at: wk?.paid_at ?? null,
        entries: es,
        total: round2(es.reduce((s, e) => s + e.amount, 0)),
        count: es.reduce((s, e) => s + e.qty, 0),
      });
    });
    return views.sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
  }, [weeks, entries]);

  const shown = weekViews.filter((w) => w.entries.length > 0);
  const unpaid = shown.filter((w) => !w.paid);
  const owed = round2(unpaid.reduce((s, w) => s + w.total, 0));
  const owedQty = unpaid.reduce((s, w) => s + w.count, 0);
  const cur = weekViews.find((w) => w.week_start === weekIdOf(todayStr())) ?? null;
  const todayEntry = cur?.entries.find((e) => e.day === todayStr()) ?? null;

  // ── actions ──
  const withBusy = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await load();
    } catch {
      setOffline(true);
    } finally {
      setBusy(false);
    }
  };

  async function addToday() {
    setAddErr("");
    if (!user) return;
    if (cur?.paid) {
      setAddErr("This week is marked paid. Reopen it to add more.");
      return;
    }
    const parsed = parseQty(qtyRaw);
    if (!parsed) {
      setAddErr("Enter a number like 5 (or 50x0.75).");
      return;
    }
    const note = noteRaw.trim().slice(0, 60);
    const day = todayStr();
    const weekId = weekIdOf(day);
    const wasThere = !!todayEntry;
    await withBusy(async () => {
      await db.addToday(weekId, day, { qty: parsed.qty, price: parsed.price, note }, todayEntry, user, device);
      setQtyRaw("");
      setNoteRaw("");
      flash(wasThere ? "Added to today" : "Today logged");
    });
  }

  async function saveEdit(entry: Entry, qty: number, note: string) {
    if (!user) return;
    await withBusy(async () => {
      await db.editEntry(entry, qty, note.trim().slice(0, 60), user, device);
      setEditing(null);
      flash("Entry updated");
    });
  }

  async function delEntry(entry: Entry) {
    if (!user) return;
    await withBusy(async () => {
      await db.deleteEntry(entry, user, device);
      setEditing(null);
      flash("Entry deleted");
    });
  }

  async function markPaid(weekId: string, paid: boolean) {
    if (!user) return;
    await withBusy(async () => {
      await db.setPaid(weekId, paid, user, device);
      flash(paid ? "Marked paid" : "Reopened");
    });
  }

  async function settleAll() {
    if (!user) return;
    const ids = unpaid.map((w) => w.week_start);
    await withBusy(async () => {
      await db.settleAll(ids, user, device);
      flash("All weeks settled");
    });
  }

  function signIn(name: string): boolean {
    const clean = name.trim().toLowerCase();
    if (!ALLOWED_NAMES.includes(clean)) return false;
    setUser(clean);
    try {
      localStorage.setItem("khata.name", clean);
    } catch {
      /* ignore */
    }
    return true;
  }

  function signOut() {
    try {
      localStorage.removeItem("khata.name");
    } catch {
      /* ignore */
    }
    setUser(null);
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
  if (checking) {
    return (
      <div className="khata">
        <div className="boot">
          <Roti size={30} />
          <span>Opening the khata…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="khata">
        <Gate onSubmit={signIn} />
      </div>
    );
  }

  return (
    <div className="khata">
      <div className="shell">
        <header className="hdr">
          <div className="brand">
            <Roti size={26} />
            <div>
              <div className="brand-name">Chapati Khata</div>
              <div className="brand-sub">the roti tab</div>
            </div>
          </div>
          <div className="hdr-r">
            <button className="icon-btn" onClick={exportJSON} aria-label="Download backup">
              <IcDownload className="ic" />
            </button>
            <button className="icon-btn" onClick={load} aria-label="Refresh" disabled={loading}>
              <IcRefresh className={"ic" + (loading ? " spin" : "")} />
            </button>
            <button
              className="who"
              onClick={() =>
                setConfirm({
                  title: "Signed in as " + cap(user),
                  body: "Switching just changes the name recorded in the log. The tab is shared.",
                  cta: "Switch user",
                  tone: "plain",
                  onYes: signOut,
                })
              }
            >
              {cap(user)}
            </button>
          </div>
        </header>

        <div className="seg" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "ledger"}
            className={"seg-b" + (tab === "ledger" ? " on" : "")}
            onClick={() => setTab("ledger")}
          >
            Ledger
          </button>
          <button
            role="tab"
            aria-selected={tab === "log"}
            className={"seg-b" + (tab === "log" ? " on" : "")}
            onClick={() => setTab("log")}
          >
            Log
          </button>
        </div>

        {offline && (
          <div className="banner">
            <span>Can’t reach the shared khata. Check your connection.</span>
            <button className="link" onClick={load}>
              Try again
            </button>
          </div>
        )}

        {tab === "ledger" ? (
          <main className="scroll">
            <section className={"topay" + (owed > 0 ? " due" : " clear")}>
              {owed > 0 ? (
                <>
                  <div className="topay-label">To pay</div>
                  <div className="topay-amt">{money(owed)}</div>
                  <div className="topay-meta">
                    {unpaid.length} week{unpaid.length > 1 ? "s" : ""} open · {owedQty} chapati
                    {owedQty !== 1 ? "s" : ""}
                  </div>
                  {unpaid.length > 1 && (
                    <button
                      className="btn btn-solid wide"
                      disabled={busy}
                      onClick={() =>
                        setConfirm({
                          title: "Settle every open week?",
                          body: "Marks all " + unpaid.length + " unpaid weeks paid — " + money(owed) + " total.",
                          cta: "Mark all paid",
                          tone: "go",
                          onYes: settleAll,
                        })
                      }
                    >
                      Settle all {unpaid.length} weeks
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="clear-badge">
                    <IcCheck className="ic" />
                  </div>
                  <div className="topay-amt sm">All settled</div>
                  <div className="topay-meta">Nothing owed to the lady right now.</div>
                </>
              )}
            </section>

            <section className="add">
              <div className="add-head">
                <span className="eyebrow">Add today</span>
                <span className="add-date">{dayLabel(todayStr())}</span>
              </div>
              <div className="add-row">
                <input
                  className="in qty"
                  inputMode="numeric"
                  placeholder="How many?"
                  value={qtyRaw}
                  onChange={(e) => {
                    setQtyRaw(sanitize(e.target.value));
                    setAddErr("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addToday();
                  }}
                  aria-label="Chapati count"
                />
                <button className="btn btn-solid add-btn" disabled={busy} onClick={addToday} aria-label="Add to today">
                  <IcPlus className="ic" />
                  <span>Add</span>
                </button>
              </div>
              <input
                className="in note"
                placeholder="Note (optional) — e.g. extra for a guest"
                value={noteRaw}
                maxLength={60}
                onChange={(e) => setNoteRaw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addToday();
                }}
                aria-label="Optional note"
              />
              {addErr && <div className="add-err">{addErr}</div>}
              {todayEntry && !addErr && (
                <div className="add-hint">
                  Today so far · <b>{todayEntry.qty}</b> chapati{todayEntry.qty !== 1 ? "s" : ""} ·{" "}
                  {money(todayEntry.amount)}
                </div>
              )}
            </section>

            {shown.length === 0 ? (
              <div className="empty">
                <Roti size={40} />
                <p>No orders yet.</p>
                <span>Add today’s chapatis above and the week will appear here.</span>
              </div>
            ) : (
              shown.map((w) => (
                <WeekCard
                  key={w.week_start}
                  w={w}
                  busy={busy}
                  onEntry={(entry) => setEditing(entry)}
                  onPay={() => markPaid(w.week_start, true)}
                  onReopen={() =>
                    setConfirm({
                      title: "Reopen this week?",
                      body:
                        "It will go back to unpaid so entries can be edited. It re-joins your total.",
                      cta: "Reopen",
                      tone: "plain",
                      onYes: () => markPaid(w.week_start, false),
                    })
                  }
                />
              ))
            )}
            <div className="foot">Shared tab · {shown.length} week{shown.length !== 1 ? "s" : ""} on record</div>
          </main>
        ) : (
          <LogView logs={logs} />
        )}
      </div>

      {editing && (
        <EditSheet
          entry={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={saveEdit}
          onDelete={delEntry}
        />
      )}

      {confirm && (
        <div className="ovl" onClick={() => setConfirm(null)}>
          <div className="dlg" onClick={(e) => e.stopPropagation()}>
            <div className="dlg-head">
              <h3 className="dlg-t">{confirm.title}</h3>
              <button className="icon-btn" onClick={() => setConfirm(null)} aria-label="Close">
                <IcX className="ic" />
              </button>
            </div>
            <p className="dlg-b">{confirm.body}</p>
            <div className="dlg-a">
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className={"btn " + (confirm.tone === "go" ? "btn-go" : "btn-solid")}
                disabled={busy}
                onClick={() => {
                  const f = confirm.onYes;
                  setConfirm(null);
                  f();
                }}
              >
                {confirm.cta}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// keep the add box to digits + a single 'x'
function sanitize(v: string): string {
  let s = v.replace(/[^0-9x]/gi, "").toLowerCase();
  const parts = s.split("x");
  if (parts.length > 2) s = parts[0] + "x" + parts.slice(1).join("");
  return s;
}
