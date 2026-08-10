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

  it.each([[undefined], [null], ["not a date"]])(
    "renders a missing timestamp (%s) as unknown, not NaNd ago",
    (iso) => {
      expect(sinceText(iso, NOW)).toBe("unknown");
    },
  );
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

  it("does not tick a digest that disagrees", () => {
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
    expect(got.text).toContain("DIFFERENT");
    expect(got.text).not.toContain("✓");
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

  it("names the empty surface as well as the unreachable one", () => {
    // .env empty and Supabase unreachable used to render only "Supabase
    // secrets — not checked", with no hint that .env held nothing.
    const setting = settingById("entry-code");
    const got = describeSetting(
      setting,
      [
        { known: true, present: false },
        { known: false, present: false, blocked: true },
      ],
      NOW,
    );
    expect(got.text).toContain(".env — not set");
    expect(got.text).toContain("Supabase secrets — not checked");
  });
});

describe("describeSetting validates what it reads back", () => {
  // The literal line README tells a new user to copy into .env.
  const PLACEHOLDER_URL = "https://YOUR-PROJECT-ref.supabase.co";

  it("warns about the .env.example URL placeholder instead of calling it set", () => {
    const setting = settingById("supabase-url");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: PLACEHOLDER_URL },
        { known: false, present: false },
      ],
      NOW,
    );
    expect(got.warning).not.toBeNull();
    expect(got.warning).toMatch(/looks wrong/);
    expect(got.warning).toContain("Supabase project URL in .env");
    expect(got.text).toMatch(/looks wrong/);
    // The user still gets to see what is actually in there.
    expect(got.text).toContain("https://YOUR…");
  });

  it("leaves a valid value unwarned", () => {
    const setting = settingById("supabase-url");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "https://abc123.supabase.co" },
        { known: false, present: true, updatedAt: "2026-08-06T12:00:00Z" },
      ],
      NOW,
    );
    expect(got.warning).toBeNull();
  });

  it("does not earn · both when one target's value looks wrong", () => {
    const setting = settingById("supabase-url");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: PLACEHOLDER_URL },
        { known: false, present: true, updatedAt: "2026-08-06T12:00:00Z" },
      ],
      NOW,
    );
    expect(got.text).not.toContain("both");
  });

  it("still treats an unrecognised-but-plausible anon key as set", () => {
    // anonKey returns { ok: true, warn } for a shape it doesn't know. A warn
    // is accept-with-caveat, not a rejection.
    const setting = settingById("supabase-anon-key");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "some-future-key-format" },
        { known: false, present: true, updatedAt: "2026-08-06T12:00:00Z" },
      ],
      NOW,
    );
    expect(got.warning).toBeNull();
    expect(got.text).toContain("both");
  });

  it("never leaks a secret's value while calling it wrong", () => {
    const setting = settingById("entry-code");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: "12" },
        { known: false, present: false, blocked: true },
      ],
      NOW,
    );
    expect(got.warning).toMatch(/looks wrong/);
    expect(got.text).not.toContain("12");
  });

  it("reports a value that looks wrong even when another target is blocked", () => {
    // A blocked target suppresses drift warnings, but a value we did read and
    // that cannot be right is evidence regardless.
    const setting = settingById("supabase-url");
    const got = describeSetting(
      setting,
      [
        { known: true, present: true, value: PLACEHOLDER_URL },
        { known: false, present: false, blocked: true },
      ],
      NOW,
    );
    expect(got.warning).toMatch(/looks wrong/);
  });
});
