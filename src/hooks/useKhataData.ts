import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, LogRow, Week, WeekView } from "../types";
import * as db from "../lib/db";
import { ensureAuth } from "../lib/supabase";
import { round2 } from "../lib/util";

export function useKhataData(onBooted: () => void) {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [paidEntries, setPaidEntries] = useState<Entry[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [hasMoreLogs, setHasMoreLogs] = useState(true);

  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);

  const historyLoadedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await db.loadActive();
      setWeeks(data.weeks);
      setEntries(data.entries);
      setLogs(data.logs);
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
        onBooted();
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

  async function loadHistory() {
    if (historyLoadedRef.current) return; // already loaded
    setLoadingHistory(true);
    try {
      const paidIds = weeks.filter((w) => w.paid).map((w) => w.week_start);
      const pe = paidIds.length > 0 ? await db.loadPaidEntries(paidIds) : [];
      setPaidEntries(pe);
      historyLoadedRef.current = true;
    } catch {
      // silent — user can retry by toggling
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
    const ids = new Set<string>([...weeks.map((w) => w.week_start), ...allEntries.map((e) => e.week_start)]);
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
  }, [weeks, allEntries]);

  const shown = weekViews.filter((w) => w.entries.length > 0);
  const unpaid = shown.filter((w) => !w.paid);
  const paid = shown.filter((w) => w.paid);
  const owed = round2(unpaid.reduce((s, w) => s + w.total, 0));
  const owedQty = unpaid.reduce((s, w) => s + w.count, 0);
  const paidCount = weeks.filter((w) => w.paid).length;
  const historyLoaded = historyLoadedRef.current;

  return {
    weeks, entries, logs,
    loading, offline, checking,
    load, markOffline,
    hasMoreLogs, loadingMore, loadMoreLogs,
    loadingHistory, historyLoaded, loadHistory,
    shown, unpaid, paid, paidCount, owed, owedQty,
  };
}
