import { describe, it, expect } from "vitest";
import { digestMatches, isPlatformManaged } from "./supabase.mjs";

describe("digestMatches", () => {
  // sha256("1234") — the digest `supabase secrets list` returns for ENTRY_CODE=1234
  const DIGEST_OF_1234 = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4";

  it("matches the plaintext that produced it", () => {
    expect(digestMatches(DIGEST_OF_1234, "1234")).toBe(true);
  });

  it("does not match a different plaintext", () => {
    expect(digestMatches(DIGEST_OF_1234, "1235")).toBe(false);
  });

  it("is false when there is no digest", () => {
    expect(digestMatches(undefined, "1234")).toBe(false);
  });
});

describe("isPlatformManaged", () => {
  it.each([
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_DB_URL",
    "SUPABASE_JWKS",
    "SUPABASE_PUBLISHABLE_KEYS",
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY",
  ])("hides %s", (name) => {
    expect(isPlatformManaged(name)).toBe(true);
  });

  it.each(["ENTRY_CODE", "SPLITWISE_API_KEY", "SPLITWISE_GROUP_ID"])("does not hide %s", (name) => {
    expect(isPlatformManaged(name)).toBe(false);
  });
});
