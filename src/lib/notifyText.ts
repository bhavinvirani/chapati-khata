import { cap, dayLabel, weekLabel } from "./util";

// What a push notification says, composed from one log row.
//
// Composed from the row's *structured* columns only — actor, action,
// qty_after, day, week_start — never from `detail`. `detail` is a display
// string built by logtext.ts and it carries a price ("21 @ $0.50 · bhavin 7"),
// which would have to be parsed apart to keep money off a lock screen. That
// would make logtext.ts's output format silently load-bearing for a second
// consumer; these columns have types instead.
//
// Deliberately no amounts anywhere: notifications land on lock screens, in
// front of whoever is nearby.

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
