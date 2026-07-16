import { useCallback, useEffect, useMemo, useState } from "react";
import type { Entry, LogRow, Week, WeekView } from "../types";
import * as db from "../lib/db";
import { ensureAuth } from "../lib/supabase";
import { round2, todayStr, weekIdOf } from "../lib/util";

export function useKhataData(onBooted: () => void) {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);

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

  // derived
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

  return {
    weeks, entries, logs,
    loading, offline, checking,
    load, markOffline,
    shown, unpaid, owed, owedQty, todayEntry, cur,
  };
}
