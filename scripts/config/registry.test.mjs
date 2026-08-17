import { describe, it, expect } from "vitest";
import { SETTINGS, settingById, WIZARD_STEPS } from "./registry.mjs";
import { SURFACES } from "./surfaces/index.mjs";
import { GROUPS } from "../config.mjs";

describe("registry integrity", () => {
  it("has fifteen settings and nineteen targets", () => {
    expect(SETTINGS).toHaveLength(15);
    expect(SETTINGS.flatMap((s) => s.targets)).toHaveLength(19);
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

  it("assigns every setting the wizard asks for to a declared step", () => {
    const steps = new Set(WIZARD_STEPS.map((w) => w.n));
    for (const s of SETTINGS.filter((s) => s.wizard)) {
      expect(steps.has(s.wizard.step), s.id).toBe(true);
    }
  });

  it("only lets a setting skip the wizard when something else fills it", () => {
    // `wizard: null` means the wizard never prompts for it — which is only
    // honest if some other setting's generator writes it.
    const generated = new Set(
      SETTINGS.filter((s) => s.generate).flatMap((s) => Object.keys(s.generate.run())),
    );
    for (const s of SETTINGS.filter((s) => s.wizard === null)) {
      expect(generated.has(s.id), s.id).toBe(true);
    }
  });

  it("has a runnable generator that only names real settings", () => {
    for (const s of SETTINGS.filter((s) => s.generate)) {
      expect(s.generate.label, s.id).toBeTruthy();
      const produced = s.generate.run();
      expect(Object.keys(produced).length, s.id).toBeGreaterThan(0);
      for (const [id, value] of Object.entries(produced)) {
        const target = settingById(id);
        expect(target, `${s.id} -> ${id}`).toBeTruthy();
        // A generator that ever emitted something its own validator rejects
        // would only surface when a notification failed to arrive.
        expect(target.validate(value).ok, `${s.id} -> ${id}`).toBe(true);
      }
    }
  });

  it("generates its own value, so the prompt it replaces is really covered", () => {
    for (const s of SETTINGS.filter((s) => s.generate)) {
      expect(Object.keys(s.generate.run()), s.id).toContain(s.id);
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
    ).toEqual([
      "entry-code",
      "notify-hook-secret",
      "splitwise-api-key",
      "supabase-access-token",
      "supabase-db-password",
      "vapid-keys",
    ]);
  });

  it("looks settings up by id", () => {
    expect(settingById("default-price").label).toBe("Default price per chapati");
    expect(settingById("nope")).toBeUndefined();
  });
});
