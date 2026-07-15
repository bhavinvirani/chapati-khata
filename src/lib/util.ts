import { CURRENCY, DEFAULT_PRICE } from "../config";

// ── money ──
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const money = (n: number) => CURRENCY + round2(n).toFixed(2);
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── dates ──
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYMD = (s: string) => new Date(`${s}T00:00:00`);
export const todayStr = () => ymd(new Date());

/** The Monday (as YYYY-MM-DD) that owns a given date — used as the week id. */
export function weekIdOf(dateStr: string): string {
  const d = parseYMD(dateStr);
  const dow = (d.getDay() + 6) % 7; // Mon = 0
  d.setDate(d.getDate() - dow);
  return ymd(d);
}
export const isCurrentWeek = (weekId: string) => weekId === weekIdOf(todayStr());

/** "Jul 13 – 19" or "Jun 30 – Jul 6" (year only when asked). */
export function weekLabel(weekId: string, withYear = false): string {
  const mon = parseYMD(weekId);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  const y = withYear ? `, ${mon.getFullYear()}` : "";
  if (mon.getMonth() === sun.getMonth())
    return `${MON[mon.getMonth()]} ${mon.getDate()} – ${sun.getDate()}${y}`;
  return `${MON[mon.getMonth()]} ${mon.getDate()} – ${MON[sun.getMonth()]} ${sun.getDate()}${y}`;
}

/** "Wed Jul 15" */
export function dayLabel(dateStr: string): string {
  const d = parseYMD(dateStr);
  return `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`;
}

/** "Jul 15 · 2:14 PM" from an ISO timestamp. */
export function stamp(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${MON[d.getMonth()]} ${d.getDate()} · ${h}:${m} ${ap}`;
}

// ── add-box parsing: "5" -> 5 @ default ; "50x0.75" -> 50 @ 0.75 ──
export interface ParsedQty {
  qty: number;
  price: number;
}
export function parseQty(raw: string): ParsedQty | null {
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    const q = parseInt(s, 10);
    return q > 0 ? { qty: q, price: DEFAULT_PRICE } : null;
  }
  const m = s.match(/^(\d+)x(\d+(?:\.\d+)?)$/);
  if (m) {
    const q = parseInt(m[1], 10);
    const p = parseFloat(m[2]);
    return q > 0 && p > 0 ? { qty: q, price: p } : null;
  }
  return null;
}

/** Restrict the add input to digits and a single 'x'. */
export function sanitizeQty(v: string): string {
  let s = v.replace(/[^0-9x]/gi, "").toLowerCase();
  const parts = s.split("x");
  if (parts.length > 2) s = parts[0] + "x" + parts.slice(1).join("");
  return s;
}
