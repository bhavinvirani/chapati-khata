import { describe, expect, it } from "vitest";
import { notifyText } from "./notifyText.ts";
import type { NotifiableLog } from "./notifyText.ts";
// The real thing the date helpers in notifyText.ts mirror. Importing it here
// is what turns "keep these in step by hand" into a check that fails.
import { cap, dayLabel, weekLabel } from "../../../src/lib/util";

const row = (over: Partial<NotifiableLog> = {}): NotifiableLog => ({
  id: "log-1",
  actor: "deven",
  action: "create",
  qty_after: 21,
  day: "2026-08-12",
  week_start: null,
  ...over,
});

describe("notifyText", () => {
  it("names the person and the count for a new add", () => {
    expect(notifyText(row())).toEqual({
      title: "Deven added 21 chapatis",
      body: "Wed Aug 12",
      tag: "add:log-1",
    });
  });

  it("says chapati, singular, for one", () => {
    expect(notifyText(row({ qty_after: 1 }))?.title).toBe("Deven added 1 chapati");
  });

  it("never puts money in a notification", () => {
    // The whole reason this composer reads columns instead of logs.detail.
    const m = notifyText(row({ qty_after: 21 }));
    expect(`${m?.title} ${m?.body}`).not.toMatch(/[$£€]|\d+\.\d\d/);
  });

  it("gives every add its own tag, so two adds never collapse", () => {
    expect(notifyText(row({ id: "a" }))?.tag).not.toBe(notifyText(row({ id: "b" }))?.tag);
  });

  it("announces a settlement with the week it covers", () => {
    expect(
      notifyText(row({ action: "paid", qty_after: null, day: null, week_start: "2026-08-10" })),
    ).toEqual({
      title: "Deven settled the khata",
      body: "Aug 10 – 16",
      tag: "paid:deven",
    });
  });

  it("tags every week of one Settle All the same, so they collapse into one", () => {
    const weeks = ["2026-07-27", "2026-08-03", "2026-08-10"].map((w) =>
      notifyText(row({ id: `log-${w}`, action: "paid", week_start: w })),
    );
    expect(new Set(weeks.map((m) => m?.tag)).size).toBe(1);
  });

  it("keeps two people's settlements apart", () => {
    const a = notifyText(row({ action: "paid", week_start: "2026-08-10" }));
    const b = notifyText(row({ action: "paid", week_start: "2026-08-10", actor: "bhavin" }));
    expect(a?.tag).not.toBe(b?.tag);
  });

  it.each([
    "edit",
    "delete",
    "reopen",
    "login",
    "add",
    "user_add",
    "user_delete",
    "user_split_on",
    "user_split_off",
    "user_login_on",
    "user_login_off",
    "splitwise_push",
    "splitwise_unpush",
  ])("stays silent for %s", (action) => {
    expect(notifyText(row({ action }))).toBeNull();
  });

  it("stays silent for an action it has never heard of", () => {
    expect(notifyText(row({ action: "something_new" }))).toBeNull();
  });

  describe("rows the column types allow but the writer never produces", () => {
    it("drops the count rather than saying null", () => {
      expect(notifyText(row({ qty_after: null }))?.title).toBe("Deven added chapatis");
    });

    it("drops the body rather than dating it wrong", () => {
      expect(notifyText(row({ day: null }))?.body).toBe("");
      expect(notifyText(row({ action: "paid", week_start: null }))?.body).toBe("");
    });

    it("falls back to Someone for a blank actor", () => {
      expect(notifyText(row({ actor: "" }))?.title).toBe("Someone added 21 chapatis");
      expect(notifyText(row({ actor: "   " }))?.title).toBe("Someone added 21 chapatis");
    });
  });

  // Deno cannot import src/lib, so this module carries its own copies of
  // util.ts's cap/dayLabel/weekLabel. These are the checks that stop the two
  // drifting: every date the app can produce, run through both.
  describe("stays in step with src/lib/util.ts", () => {
    const everyDayOfAYear = Array.from({ length: 366 }, (_, i) => {
      const d = new Date(2026, 0, 1 + i);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    });

    it("formats every day of a year exactly as dayLabel does", () => {
      for (const day of everyDayOfAYear) {
        expect(notifyText(row({ day }))?.body).toBe(dayLabel(day));
      }
    });

    it("formats every week of a year exactly as weekLabel does", () => {
      // Mondays only — the week ids weekIdOf produces. Covers the same-month
      // and cross-month spans, and the year boundary.
      const mondays = everyDayOfAYear.filter((d) => new Date(`${d}T00:00:00`).getDay() === 1);
      expect(mondays.length).toBeGreaterThan(50);
      for (const week_start of mondays) {
        expect(notifyText(row({ action: "paid", week_start }))?.body).toBe(weekLabel(week_start));
      }
    });

    it("capitalises names exactly as cap does", () => {
      for (const actor of ["deven", "bhavin", "samir", "a", "mary-jane", "élodie"]) {
        expect(notifyText(row({ actor }))?.title).toBe(`${cap(actor)} added 21 chapatis`);
      }
    });
  });
});
