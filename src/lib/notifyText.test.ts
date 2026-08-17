import { describe, expect, it } from "vitest";
import { notifyText } from "./notifyText";
import type { NotifiableLog } from "./notifyText";

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
});
