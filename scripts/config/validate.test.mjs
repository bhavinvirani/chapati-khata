import { describe, it, expect } from "vitest";
import {
  positiveNumber,
  currencySymbol,
  currencyCode,
  nonEmpty,
  token,
  fourDigits,
  groupId,
  supabaseUrl,
  anonKey,
} from "./validate.mjs";

describe("positiveNumber", () => {
  it("accepts a decimal price", () => {
    expect(positiveNumber("0.75")).toEqual({ ok: true, value: 0.75 });
  });
  it("trims whitespace", () => {
    expect(positiveNumber("  1.5  ")).toEqual({ ok: true, value: 1.5 });
  });
  it.each(["0", "-1", "abc", "", "Infinity", "NaN"])("rejects %j", (raw) => {
    expect(positiveNumber(raw).ok).toBe(false);
  });
});

describe("currencySymbol", () => {
  it("accepts a single symbol", () => {
    expect(currencySymbol("$")).toEqual({ ok: true, value: "$" });
  });
  it("accepts up to three characters", () => {
    expect(currencySymbol("CA$")).toEqual({ ok: true, value: "CA$" });
  });
  it.each(["", "abcd", "a b"])("rejects %j", (raw) => {
    expect(currencySymbol(raw).ok).toBe(false);
  });
});

describe("currencyCode", () => {
  it("uppercases a lowercase code", () => {
    expect(currencyCode("cad")).toEqual({ ok: true, value: "CAD" });
  });
  it.each(["CA", "CADD", "C4D", ""])("rejects %j", (raw) => {
    expect(currencyCode(raw).ok).toBe(false);
  });
});

describe("nonEmpty", () => {
  it("accepts text with inner spaces", () => {
    expect(nonEmpty(" Groceries ")).toEqual({ ok: true, value: "Groceries" });
  });
  it("rejects whitespace only", () => {
    expect(nonEmpty("   ").ok).toBe(false);
  });
});

describe("token", () => {
  it("accepts an opaque token", () => {
    expect(token("sbp_abc123")).toEqual({ ok: true, value: "sbp_abc123" });
  });
  it.each(["", "has space"])("rejects %j", (raw) => {
    expect(token(raw).ok).toBe(false);
  });
});

describe("fourDigits", () => {
  it("accepts exactly four digits", () => {
    expect(fourDigits("1234")).toEqual({ ok: true, value: "1234" });
  });
  it.each(["123", "12345", "12a4", ""])("rejects %j", (raw) => {
    expect(fourDigits(raw).ok).toBe(false);
  });
});

describe("groupId", () => {
  it("accepts digits", () => {
    expect(groupId("87654321")).toEqual({ ok: true, value: "87654321" });
  });
  it("rejects a pasted group URL", () => {
    const result = groupId("https://secure.splitwise.com/groups/87654321");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not the whole URL/);
  });
});

describe("supabaseUrl", () => {
  it("accepts a project URL", () => {
    expect(supabaseUrl("https://abc123.supabase.co")).toEqual({
      ok: true,
      value: "https://abc123.supabase.co",
    });
  });
  it("strips a trailing slash", () => {
    expect(supabaseUrl("https://abc123.supabase.co/").value).toBe("https://abc123.supabase.co");
  });
  it.each(["http://abc123.supabase.co", "https://supabase.co", "abc123"])("rejects %j", (raw) => {
    expect(supabaseUrl(raw).ok).toBe(false);
  });
});

describe("anonKey", () => {
  it("accepts a legacy JWT", () => {
    expect(anonKey("eyJhbGci.eyJpc3Mi.c2ln").warn).toBeUndefined();
  });
  it("accepts a publishable key", () => {
    expect(anonKey("sb_publishable_abc123").warn).toBeUndefined();
  });
  it("warns but accepts an unrecognised format", () => {
    const result = anonKey("something-else-entirely");
    expect(result.ok).toBe(true);
    expect(result.warn).toMatch(/live check/);
  });
  it("rejects empty", () => {
    expect(anonKey("").ok).toBe(false);
  });
});
