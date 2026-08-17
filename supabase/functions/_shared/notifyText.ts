// What a push notification says, composed from one log row.
//
// This lives under supabase/functions/ because the `notify` edge function is
// its only consumer — Deno cannot import from src/lib (the same constraint
// that made validate-access hand-duplicate normalizeName). It is deliberately
// plain TypeScript with no imports and no `Deno.*`, so vitest can import and
// test it directly from notifyText.test.ts rather than a second copy being
// kept in step by hand.
//
// The date and name helpers below ARE mirrors of src/lib/util.ts. They are
// pinned by an executable check, not a comment: notifyText.test.ts imports
// the real util.ts and asserts the two agree across a year of dates.
//
// Text is composed from the log row's *structured* columns — actor, action,
// qty_after, day, week_start — never from `detail`. `detail` is a display
// string built by logtext.ts and it carries a price ("21 @ $0.50 · bhavin 7"),
// which would have to be parsed apart to keep money off a lock screen; that
// would make logtext.ts's output format silently load-bearing for a second
// consumer. Deliberately no amounts anywhere: notifications land on lock
// screens, in front of whoever is nearby.

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 'YYYY-MM-DD' at local midnight. Only Y/M/D/day-of-week are ever read back
 * off it, so the result is the same in vitest's pinned Toronto and in the
 * edge runtime's UTC. */
function parseYMD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "Wed Aug 12" — mirrors util.ts's dayLabel. */
function dayLabel(dateStr: string): string {
  const d = parseYMD(dateStr);
  return `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`;
}

/** "Aug 10 – 16" or "Jun 29 – Jul 5" — mirrors util.ts's weekLabel for the
 * Monday–Sunday span a week id names. */
function weekLabel(weekId: string): string {
  const mon = parseYMD(weekId);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  if (mon.getMonth() === sun.getMonth()) {
    return `${MON[mon.getMonth()]} ${mon.getDate()} – ${sun.getDate()}`;
  }
  return `${MON[mon.getMonth()]} ${mon.getDate()} – ${MON[sun.getMonth()]} ${sun.getDate()}`;
}

/** Mirrors util.ts's cap. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The subset of a `LogRow` a notification is built from. */
export interface NotifiableLog {
  id: string;
  actor: string;
  action: string;
  qty_after: number | null;
  day: string | null;
  week_start: string | null;
}

export interface NotifyMessage {
  title: string;
  body: string;
  /**
   * The OS notification tag. Two notifications sharing a tag collapse into
   * one, the later replacing the earlier — which is what stops a Settle All
   * across three weeks (three `paid` log rows, three sends) from stacking up
   * three cards and three buzzes.
   */
  tag: string;
}

/** A blank actor can't happen through the gate, but the column only says `not null`. */
const who = (actor: string) => (actor.trim() ? cap(actor) : "Someone");

/**
 * The notification for a log row, or `null` if that action is not one people
 * are notified about.
 *
 * The list of notifiable actions lives here rather than at the call site, so
 * the trigger's `when` clause and this function are the only two places that
 * need to agree — see the design's §3.3.
 */
export function notifyText(log: NotifiableLog): NotifyMessage | null {
  switch (log.action) {
    case "create": {
      const qty = log.qty_after;
      // `qty_after` is always written for a create, but the column is
      // nullable — degrade to a countless sentence rather than "added null".
      const what = qty === null ? "chapatis" : `${qty} ${qty === 1 ? "chapati" : "chapatis"}`;
      return {
        title: `${who(log.actor)} added ${what}`,
        body: log.day ? dayLabel(log.day) : "",
        // Every add is its own event: unique tag, so two adds never collapse.
        tag: `add:${log.id}`,
      };
    }
    case "paid":
      return {
        title: `${who(log.actor)} settled the khata`,
        body: log.week_start ? weekLabel(log.week_start) : "",
        // One tag per person, so the several rows a multi-week Settle All
        // writes land as a single notification.
        tag: `paid:${log.actor}`,
      };
    default:
      return null;
  }
}
