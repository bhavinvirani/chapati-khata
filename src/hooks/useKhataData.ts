import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, LogRow, Settlement, User, Week, WeekView } from "../types";
import * as db from "../lib/db";
import { ensureAuth } from "../lib/supabase";
import { round2 } from "../lib/util";

export function useKhataData(onBooted: () => void | Promise<void>) {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [paidEntries, setPaidEntries] = useState<Entry[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [hasMoreLogs, setHasMoreLogs] = useState(true);

  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);

  // Ref: closure-stable "already loaded" check inside `load` (kept out of its
  // deps so `load`'s identity — and the effects that depend on it — stay put).
  const historyLoadedRef = useRef(false);
  // State: the same flag, mirrored for consumers that render off it.
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await db.loadActive();
      setWeeks(data.weeks);
      setEntries(data.entries);
      setUsers(data.users);
      setLogs(data.logs);
      setSettlements(data.settlements);
      setHasMoreLogs(data.logs.length >= db.LOG_PAGE);
      setOffline(false);

      // If history was previously loaded, refresh paid entries too
      // so transitions (mark paid / reopen) stay in sync.
      if (historyLoadedRef.current) {
        const paidIds = data.weeks.filter((w) => w.paid).map((w) => w.week_start);
        const pe = paidIds.length > 0 ? await db.loadPaidEntries(paidIds) : [];
        setPaidEntries(pe);
      }
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const markOffline = useCallback(() => setOffline(true), []);

  // auth gate + first load
  useEffect(() => {
    (async () => {
      try {
        await ensureAuth();
        await onBooted();
        setReady(true);
        await load();
      } catch {
        setOffline(true);
      } finally {
        setChecking(false);
      }
    })();
  }, [load, onBooted]);

  // realtime + refresh on focus
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

  // ── log pagination ──
  const [loadingMore, setLoadingMore] = useState(false);

  async function loadMoreLogs() {
    if (!hasMoreLogs || logs.length === 0 || loadingMore) return;
    setLoadingMore(true);
    try {
      const last = logs[logs.length - 1];
      const more = await db.loadMoreLogs(last.ts, last.id);
      if (more.length > 0) setLogs((prev) => [...prev, ...more]);
      setHasMoreLogs(more.length >= db.LOG_PAGE);
    } catch {
      // silent — user can retry
    } finally {
      setLoadingMore(false);
    }
  }

  // ── lazy load paid entries ──
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Returns the paid entries it loaded (or, once already loaded, the current
  // `paidEntries` unchanged) so a caller that needs them right after the
  // await — like a backup export — reads real data instead of a stale render
  // closure. Rethrows on failure instead of swallowing: callers that need to
  // know a load failed (a backup that must not go out partial) can now tell
  // that apart from an empty history. Callers that don't — the Paid history
  // expander — catch quietly at their own call site.
  async function loadHistory(): Promise<Entry[]> {
    if (historyLoadedRef.current) return paidEntries; // already loaded
    setLoadingHistory(true);
    try {
      const paidIds = weeks.filter((w) => w.paid).map((w) => w.week_start);
      const pe = paidIds.length > 0 ? await db.loadPaidEntries(paidIds) : [];
      setPaidEntries(pe);
      historyLoadedRef.current = true;
      setHistoryLoaded(true);
      return pe;
    } finally {
      setLoadingHistory(false);
    }
  }

  // ── derived ──
  const allEntries = useMemo(() => [...entries, ...paidEntries], [entries, paidEntries]);

  const weekViews: WeekView[] = useMemo(() => {
    const byWeek = new Map<string, Entry[]>();
    for (const e of allEntries) {
      const arr = byWeek.get(e.week_start) ?? [];
      arr.push(e);
      byWeek.set(e.week_start, arr);
    }
    const paidMap = new Map(weeks.map((w) => [w.week_start, w]));
    const settlementsById = new Map(settlements.map((s) => [s.id, s]));
    const ids = new Set<string>([
      ...weeks.map((w) => w.week_start),
      ...allEntries.map((e) => e.week_start),
    ]);
    const views: WeekView[] = [];
    ids.forEach((id) => {
      const es = byWeek.get(id) ?? [];
      const wk = paidMap.get(id);
      views.push({
        week_start: id,
        paid: wk?.paid ?? false,
        paid_at: wk?.paid_at ?? null,
        settlement_id: wk?.settlement_id ?? null,
        settlement: wk?.settlement_id ? (settlementsById.get(wk.settlement_id) ?? null) : null,
        entries: es,
        total: round2(es.reduce((s, e) => s + e.amount, 0)),
        count: es.reduce((s, e) => s + e.qty, 0),
      });
    });
    return views.sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
  }, [weeks, allEntries, settlements]);

  const { shown, unpaid, paid, owed, owedQty, paidCount } = useMemo(() => {
    const s = weekViews.filter((w) => w.entries.length > 0);
    const u = s.filter((w) => !w.paid);
    const p = s.filter((w) => w.paid);
    return {
      shown: s,
      unpaid: u,
      paid: p,
      owed: round2(u.reduce((acc, w) => acc + w.total, 0)),
      owedQty: u.reduce((acc, w) => acc + w.count, 0),
      paidCount: weeks.filter((w) => w.paid).length,
    };
  }, [weekViews, weeks]);

  return {
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
  };
}
