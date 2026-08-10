import { describe, it, expect } from "vitest";
import { parseSecretList, repoSurface, envSurface } from "./github.mjs";

describe("parseSecretList", () => {
  const JSON_OUT =
    '[{"name":"SUPABASE_URL","updatedAt":"2026-07-15T23:21:52Z"},' +
    '{"name":"SUPABASE_ANON_KEY","updatedAt":"2026-07-15T23:21:36Z"}]';

  it("maps names to update times", () => {
    const got = parseSecretList(JSON_OUT);
    expect(got.get("SUPABASE_URL")).toEqual({ updatedAt: "2026-07-15T23:21:52Z" });
  });

  it("returns an empty map for an empty list", () => {
    expect(parseSecretList("[]").size).toBe(0);
  });
});

describe("surface identity", () => {
  it("exposes two distinct surfaces with distinct effects", () => {
    expect(repoSurface.id).toBe("github-repo");
    expect(envSurface.id).toBe("github-env");
    expect(repoSurface.effect).toBe("needs-deploy");
    expect(envSurface.effect).toBe("next-deploy");
  });
});
