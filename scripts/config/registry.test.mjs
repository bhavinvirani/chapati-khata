import { describe, it, expect } from "vitest";
import { SETTINGS, settingById, WIZARD_STEPS } from "./registry.mjs";
import { SURFACES } from "./surfaces/index.mjs";
import { GROUPS } from "../config.mjs";

describe("registry integrity", () => {
  it("has eleven settings and fourteen targets", () => {
    expect(SETTINGS).toHaveLength(11);
    expect(SETTINGS.flatMap((s) => s.targets)).toHaveLength(14);
  });

  it("gives every setting a unique id", () => {
    const ids = SETTINGS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points every target at a surface that exists", () => {
    for (const s of SETTINGS) {
      for (const t of s.targets) {
        expect(SURFACES[t.surface], `${s.id} -> ${t.surface}`).toBeDefined();
      }
    }
  });

  it("gives every setting a group on the status screen", () => {
    // printStatus groups by targets[0].surface. Reordering a setting's
    // targets would otherwise drop it off the status screen in silence.
    const grouped = new Set(GROUPS.map((g) => g.surface));
    for (const s of SETTINGS) {
      expect(grouped.has(s.targets[0].surface), `${s.id} -> ${s.targets[0].surface}`).toBe(true);
    }
  });

  it("never lets two settings claim the same target", () => {
    const seen = new Set();
    for (const s of SETTINGS) {
      for (const t of s.targets) {
        const slot = `${t.surface}:${t.key}`;
        expect(seen.has(slot), `${slot} claimed twice`).toBe(false);
        seen.add(slot);
      }
    }
  });

  it("gives every setting a callable validator", () => {
    for (const s of SETTINGS) {
      expect(typeof s.validate, s.id).toBe("function");
    }
  });

  it("gives every setting a label and help text", () => {
    for (const s of SETTINGS) {
      expect(s.label, s.id).toBeTruthy();
      expect(s.help, s.id).toBeTruthy();
    }
  });

  it("assigns every setting to a declared wizard step", () => {
    const steps = new Set(WIZARD_STEPS.map((w) => w.n));
    for (const s of SETTINGS) {
      expect(steps.has(s.wizard.step), s.id).toBe(true);
    }
  });

  it("gives every obtain block a url and instructions", () => {
    for (const s of SETTINGS.filter((s) => s.obtain)) {
      expect(s.obtain.url, s.id).toMatch(/^https:\/\//);
      expect(s.obtain.instructions, s.id).toBeTruthy();
    }
  });

  it("marks exactly the sensitive settings as secret", () => {
    expect(
      SETTINGS.filter((s) => s.secret)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["entry-code", "splitwise-api-key", "supabase-access-token", "supabase-db-password"]);
  });

  it("looks settings up by id", () => {
    expect(settingById("default-price").label).toBe("Default price per chapati");
    expect(settingById("nope")).toBeUndefined();
  });
});
