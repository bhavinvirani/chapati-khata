import { describe, it, expect, vi, afterEach } from "vitest";
import {
  GROUPS,
  checkSupabase,
  gitErrorText,
  menuEntries,
  printStatus,
  printRemainingSteps,
  stillMissing,
} from "./config.mjs";
import { SETTINGS, settingById } from "./config/registry.mjs";

/** Every surface reachable, unless named in `down`. */
function probes(down = {}) {
  const ids = ["config-file", "dotenv", "supabase", "github-repo", "github-env"];
  return new Map(
    ids.map((id) => [id, down[id] ? { available: false, reason: down[id] } : { available: true }]),
  );
}

const BLOCKED = { known: false, present: false, blocked: true };
const ABSENT = { known: false, present: false };

/** A value each setting's own validator accepts. */
function sampleFor(setting) {
  const samples = {
    "supabase-url": "https://abc123.supabase.co",
    "supabase-anon-key": "sb_publishable_abc",
    "entry-code": "1234",
    "default-price": 0.5,
    currency: "$",
    "splitwise-currency": "CAD",
    "splitwise-category": "Groceries",
    "splitwise-group-id": "123",
  };
  return samples[setting.id] ?? "value";
}

/** A state for every target of every setting, from a per-setting override. */
function statesFor(probeMap, overrides = {}) {
  const states = new Map();
  for (const setting of SETTINGS) {
    states.set(
      setting.id,
      setting.targets.map((t, i) => {
        if (!probeMap.get(t.surface)?.available) return BLOCKED;
        return overrides[setting.id]?.[i] ?? ABSENT;
      }),
    );
  }
  return states;
}

function capture(fn) {
  const lines = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

afterEach(() => vi.restoreAllMocks());

describe("printStatus summary", () => {
  it("claims everything agrees only when everything was reachable and set", () => {
    const probeMap = probes();
    const overrides = {};
    for (const setting of SETTINGS) {
      overrides[setting.id] = setting.targets.map((t) =>
        t.surface === "dotenv" || t.surface === "config-file"
          ? { known: true, present: true, value: sampleFor(setting) }
          : { known: false, present: true, updatedAt: "2026-08-06T12:00:00Z" },
      );
    }
    const out = capture(() =>
      printStatus({ probes: probeMap, states: statesFor(probeMap, overrides), strays: [] }),
    );
    expect(out).toContain("everything agrees");
    expect(out).not.toContain("not checked");
  });

  it("does not claim everything agrees on a fresh clone with neither CLI installed", () => {
    // The exact reported scenario: no gh, no supabase. Four settings hidden,
    // three half-read, and the closing line was still green.
    const probeMap = probes({
      supabase: "Supabase CLI not installed — see supabase.com/docs/guides/cli",
      "github-repo": "GitHub CLI not installed — see cli.github.com",
      "github-env": "GitHub CLI not installed — see cli.github.com",
    });
    const overrides = {
      "supabase-url": [{ known: true, present: true, value: "https://abc123.supabase.co" }],
      "supabase-anon-key": [{ known: true, present: true, value: "sb_publishable_abc" }],
      "entry-code": [{ known: true, present: true, value: "1234" }],
    };
    const out = capture(() =>
      printStatus({ probes: probeMap, states: statesFor(probeMap, overrides), strays: [] }),
    );
    expect(out).not.toContain("everything agrees");
    expect(out).toContain("nothing disagrees");
    expect(out).toMatch(/nothing disagrees — \d+ settings not checked/);
  });

  it("counts hidden settings and half-read ones together", () => {
    const probeMap = probes({ supabase: "not linked" });
    const out = capture(() =>
      printStatus({ probes: probeMap, states: statesFor(probeMap), strays: [] }),
    );
    // 2 Splitwise settings hidden with the group + entry-code half-read.
    expect(out).toContain("nothing disagrees — 3 settings not checked");
  });

  it("still leads with real issues rather than the not-checked line", () => {
    const probeMap = probes({ supabase: "not linked" });
    const overrides = {
      "supabase-url": [{ known: true, present: true, value: "https://abc123.supabase.co" }, ABSENT],
    };
    const out = capture(() =>
      printStatus({ probes: probeMap, states: statesFor(probeMap, overrides), strays: [] }),
    );
    expect(out).toContain("issue");
    expect(out).not.toContain("nothing disagrees");
  });

  it("surfaces a .env.example placeholder as an issue, not as configured", () => {
    const probeMap = probes();
    const overrides = {
      "supabase-url": [
        { known: true, present: true, value: "https://YOUR-PROJECT-ref.supabase.co" },
        { known: false, present: true, updatedAt: "2026-08-06T12:00:00Z" },
      ],
    };
    const out = capture(() =>
      printStatus({ probes: probeMap, states: statesFor(probeMap, overrides), strays: [] }),
    );
    expect(out).toMatch(/looks wrong/);
  });

  it("renders a group heading for every group", () => {
    const probeMap = probes();
    const out = capture(() =>
      printStatus({ probes: probeMap, states: statesFor(probeMap), strays: [] }),
    );
    for (const group of GROUPS) expect(out).toContain(group.title);
  });
});

describe("menuEntries", () => {
  it("offers every setting when every surface is reachable", () => {
    const entries = menuEntries({ probes: probes() });
    expect(entries).toHaveLength(SETTINGS.length);
    expect(entries.every((e) => e.key)).toBe(true);
    expect(entries.map((e) => e.key)).toEqual(SETTINGS.map((_, i) => String(i + 1)));
  });

  it("still offers a partially blocked setting, with the caveat spelled out", () => {
    // The reported case: no Supabase CLI, so "Entry code" vanished from the
    // menu although .env — the thing `npm run dev` reads — was writable.
    const entries = menuEntries({ probes: probes({ supabase: "project not linked" }) });
    const entry = entries.find((e) => e.setting.id === "entry-code");
    expect(entry.key).not.toBeNull();
    expect(entry.label).toContain("Entry code");
    expect(entry.label).toContain("Supabase secrets unavailable");
    expect(entry.label).toContain("will write .env only");
  });

  it("lists a fully blocked setting rather than dropping it", () => {
    const entries = menuEntries({ probes: probes({ supabase: "project not linked" }) });
    const entry = entries.find((e) => e.setting.id === "splitwise-api-key");
    expect(entry.key).toBeNull();
    expect(entry.label).toContain("project not linked");
  });

  it("keeps numbering contiguous and pointing at the right setting", () => {
    const entries = menuEntries({ probes: probes({ supabase: "project not linked" }) });
    const keyed = entries.filter((e) => e.key);
    expect(keyed.map((e) => e.key)).toEqual(keyed.map((_, i) => String(i + 1)));
    // A number resolves to the setting printed against it, not to an index
    // into the unfiltered list.
    for (const [i, entry] of keyed.entries()) {
      expect(entries.find((e) => e.key === String(i + 1)).setting.id).toBe(entry.setting.id);
    }
  });

  it("never silently drops a setting", () => {
    const entries = menuEntries({
      probes: probes({ supabase: "down", "github-repo": "down", "github-env": "down" }),
    });
    expect(entries.map((e) => e.setting.id).sort()).toEqual(SETTINGS.map((s) => s.id).sort());
  });
});

describe("stillMissing", () => {
  const report = (overrides, down = {}) => {
    const probeMap = probes(down);
    return { probes: probeMap, states: statesFor(probeMap, overrides) };
  };

  it("names every required setting when nothing is configured", () => {
    const missing = stillMissing(report({}));
    const required = SETTINGS.filter((s) => s.wizard.required).map((s) => s.id);
    expect(missing.map((m) => m.setting.id).sort()).toEqual(required.sort());
    expect(missing.every((m) => m.reason)).toBe(true);
  });

  it("never lists an optional setting", () => {
    const missing = stillMissing(report({}));
    expect(missing.some((m) => m.setting.id === "splitwise-api-key")).toBe(false);
  });

  it("drops a required setting once it is set", () => {
    const missing = stillMissing(
      report({
        "supabase-url": [
          { known: true, present: true, value: "https://abc123.supabase.co" },
          ABSENT,
        ],
      }),
    );
    expect(missing.some((m) => m.setting.id === "supabase-url")).toBe(false);
  });

  it("keeps a required setting whose value looks wrong", () => {
    const missing = stillMissing(
      report({
        "supabase-url": [
          { known: true, present: true, value: "https://YOUR-PROJECT-ref.supabase.co" },
          ABSENT,
        ],
      }),
    );
    const hit = missing.find((m) => m.setting.id === "supabase-url");
    expect(hit.reason).toMatch(/looks wrong/);
  });

  it("says why a required setting could not be checked", () => {
    const missing = stillMissing(report({}, { "github-env": "not authenticated" }));
    const hit = missing.find((m) => m.setting.id === "supabase-access-token");
    expect(hit.reason).toContain("not checked");
    expect(hit.reason).toContain("not authenticated");
  });

  it("prefers 'not set' over 'not checked' when a reachable target was empty", () => {
    // Entry code with no .env line and no Supabase CLI: the user's problem is
    // the missing value, not the missing CLI.
    const missing = stillMissing(report({}, { supabase: "Supabase CLI not installed" }));
    const hit = missing.find((m) => m.setting.id === "entry-code");
    expect(hit.reason).toBe("not set");
  });
});

describe("printRemainingSteps", () => {
  it("says nothing about missing settings when none are", () => {
    const out = capture(() => printRemainingSteps([]));
    expect(out).not.toContain("Still missing");
    expect(out).toContain("Left to do in a browser");
  });

  it("lists what is still undone before the browser steps", () => {
    const out = capture(() =>
      printRemainingSteps([{ setting: settingById("entry-code"), reason: "not set" }]),
    );
    expect(out).toContain("Still missing");
    expect(out).toContain("Entry code");
    expect(out.indexOf("Still missing")).toBeLessThan(out.indexOf("Left to do in a browser"));
  });
});

describe("checkSupabase", () => {
  const respond = (init) => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", init));

  it("passes on a 200", async () => {
    respond({ status: 200 });
    expect(await checkSupabase("https://abc123.supabase.co", "key")).toEqual({ ok: true });
  });

  it.each([[401], [403]])("fails on a %s", async (status) => {
    respond({ status });
    const got = await checkSupabase("https://abc123.supabase.co", "key");
    expect(got.ok).toBe(false);
    expect(got.reason).toContain(String(status));
  });

  it("does not call a paused project a working one", async () => {
    // A paused free-tier project answers, but not with anything that proves
    // the URL and key work. This used to render a green tick.
    respond({ status: 540 });
    const got = await checkSupabase("https://abc123.supabase.co", "key");
    expect(got.ok).toBeNull();
    expect(got.reason).toContain("540");
    expect(got.reason).toMatch(/paused/);
  });

  it("reports a network failure as undetermined", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const got = await checkSupabase("https://nope.supabase.co", "key");
    expect(got.ok).toBeNull();
  });
});

describe("gitErrorText", () => {
  it("picks the fatal line out of git's several", () => {
    const err = new Error("Command failed: git commit -m x");
    err.stderr =
      'Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n  git config --global user.email "you@example.com"\n\nfatal: unable to auto-detect email address\n';
    expect(gitErrorText(err)).toBe("fatal: unable to auto-detect email address");
  });

  it("falls back to the first line it has", () => {
    expect(gitErrorText(new Error("git not found"))).toBe("git not found");
  });

  it("never returns empty", () => {
    expect(gitErrorText(undefined)).toBe("unknown error");
  });
});
