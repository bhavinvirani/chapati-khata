import { describe, it, expect } from "vitest";
import { describeSetting, maskValue, sinceText } from "./render.mjs";
import { settingById } from "./registry.mjs";

const NOW = new Date("2026-08-09T12:00:00Z");

describe("sinceText", () => {
  it.each([
    ["2026-08-09T11:00:00Z", "today"],
    ["2026-08-06T12:00:00Z", "3d ago"],
    ["2026-07-20T12:00:00Z", "20d ago"],
  ])("renders %s as %s", (iso, expected) => {
    expect(sinceText(iso, NOW)).toBe(expected);
  });
});

describe("maskValue", () => {
  it("shows a plain value in full", () => {
    expect(maskValue(settingById("default-price"), 0.5)).toBe("0.5");
  });

  it("never shows a secret value", () => {
    expect(maskValue(settingById("entry-code"), "1234")).toBe("••••");
  });

  it("truncates a long value", () => {
    const long = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    expect(maskValue(settingById("supabase-anon-key"), long)).toBe("eyJhbGciOiJI…");
  });
});

describe("describeSetting", () => {
  it("reports a single readable target", () => {
    const setting = settingById("default-price");
    const got = describeSetting(setting, [{ known: true, present: true, value: 0.5 }], NOW);
    expect(got.text).toBe("0.5");
    expect(got.warning).toBeNull();
  });

  it("reports both targets set", () => {
    const setting = settingById("supabase-url");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "https://abc123.supabase.co" },
        { known: false, present: true, updatedAt: "2026-08-06T12:00:00Z" },
      ],
      NOW,
    );
    expect(got.text).toContain("https://abc1…");
    expect(got.text).toContain("both");
    expect(got.warning).toBeNull();
  });

  it("warns when one target is set and another is not", () => {
    const setting = settingById("entry-code");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "1234" },
        { known: false, present: false },
      ],
      NOW,
    );
    expect(got.warning).toMatch(/Supabase secrets/);
    expect(got.warning).toMatch(/not set/);
  });

  it("confirms a digest match without revealing the value", () => {
    const setting = settingById("entry-code");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "1234" },
        {
          known: false,
          present: true,
          updatedAt: "2026-08-06T12:00:00Z",
          digest: "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
        },
      ],
      NOW,
    );
    expect(got.text).toContain("matches");
    expect(got.text).not.toContain("1234");
    expect(got.warning).toBeNull();
  });

  it("warns when the digest disagrees with the local value", () => {
    const setting = settingById("entry-code");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "9999" },
        {
          known: false,
          present: true,
          updatedAt: "2026-08-06T12:00:00Z",
          digest: "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
        },
      ],
      NOW,
    );
    expect(got.warning).toMatch(/differs/);
  });

  it("reports nothing set at all", () => {
    const setting = settingById("splitwise-group-id");
    const got = describeSetting(setting, [{ known: false, present: false }], NOW);
    expect(got.text).toBe("not set");
  });

  it("does not warn about drift when a target could not be checked", () => {
    // The exact reported scenario: a fresh clone with .env filled in but
    // `supabase link` never run, so the second target was never read.
    const setting = settingById("entry-code");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "1234" },
        { known: false, present: false, blocked: true },
      ],
      NOW,
    );
    expect(got.text).toContain("not checked");
    expect(got.warning).toBeNull();
  });

  it("does not earn · both when one target could not be checked", () => {
    const setting = settingById("supabase-url");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "https://abc123.supabase.co" },
        { known: false, present: false, blocked: true },
      ],
      NOW,
    );
    expect(got.text).not.toContain("both");
  });

  it("reports not checked when every target is blocked", () => {
    const setting = settingById("entry-code");
    const got = describeSetting(
      setting,
      [
        { known: false, present: false, blocked: true },
        { known: false, present: false, blocked: true },
      ],
      NOW,
    );
    expect(got.text).toBe("not checked");
    expect(got.warning).toBeNull();
  });
});
