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
  contactUri,
  vapidPublicKey,
  vapidKeys,
  hookSecret,
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

describe("contactUri", () => {
  it.each(["mailto:you@example.com", "https://example.com/khata"])("accepts %j", (raw) => {
    expect(contactUri(raw).ok).toBe(true);
  });
  it.each(["", "you@example.com", "http://example.com", "mailto:nope", "mailto: a@b.c"])(
    "rejects %j",
    (raw) => {
      expect(contactUri(raw).ok).toBe(false);
    },
  );
});

describe("vapidPublicKey", () => {
  const valid = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString("base64url");

  it("accepts a real uncompressed P-256 point", () => {
    expect(vapidPublicKey(valid).ok).toBe(true);
  });
  it("rejects standard base64, which pushManager.subscribe will not take", () => {
    const std = Buffer.from(valid, "base64url").toString("base64");
    expect(vapidPublicKey(std).ok).toBe(false);
  });
  it("rejects a key of the wrong length, naming the length it got", () => {
    const short = Buffer.alloc(32, 4).toString("base64url");
    expect(vapidPublicKey(short).reason).toMatch(/65 bytes, this one is 32/);
  });
  it("rejects a compressed point", () => {
    const compressed = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 7)]).toString(
      "base64url",
    );
    expect(vapidPublicKey(compressed).reason).toMatch(/0x04/);
  });
  it("rejects empty", () => {
    expect(vapidPublicKey("").ok).toBe(false);
  });
});

describe("vapidKeys", () => {
  const pub = { kty: "EC", crv: "P-256", x: "x", y: "y" };
  const priv = { ...pub, d: "d" };
  const pair = JSON.stringify({ publicKey: pub, privateKey: priv });

  it("accepts a generated pair", () => {
    expect(vapidKeys(pair).ok).toBe(true);
  });
  it("normalises whitespace out of the stored JSON", () => {
    expect(vapidKeys(JSON.stringify({ publicKey: pub, privateKey: priv }, null, 2)).value).toBe(
      pair,
    );
  });
  it("points at generating rather than typing when it is not JSON", () => {
    expect(vapidKeys("not json").reason).toMatch(/generate it/);
  });
  it("rejects a pair missing one half", () => {
    expect(vapidKeys(JSON.stringify({ publicKey: pub })).ok).toBe(false);
  });
  it("rejects a private key with no d — the sender could not sign", () => {
    expect(vapidKeys(JSON.stringify({ publicKey: pub, privateKey: pub })).reason).toMatch(/\(d\)/);
  });
  it("rejects a public key carrying d, which would ship the secret", () => {
    expect(vapidKeys(JSON.stringify({ publicKey: priv, privateKey: priv })).ok).toBe(false);
  });
  it.each(["RSA", "OKP"])("rejects a %s key", (kty) => {
    expect(vapidKeys(JSON.stringify({ publicKey: { ...pub, kty }, privateKey: priv })).ok).toBe(
      false,
    );
  });
  it("rejects the wrong curve", () => {
    const wrong = { ...pub, crv: "P-384" };
    expect(vapidKeys(JSON.stringify({ publicKey: wrong, privateKey: priv })).ok).toBe(false);
  });
});

describe("hookSecret", () => {
  it("accepts a generated secret", () => {
    expect(hookSecret("a".repeat(43)).ok).toBe(true);
  });
  it("rejects something short enough to guess", () => {
    expect(hookSecret("hunter2").ok).toBe(false);
  });
  it("rejects spaces, which would not survive a header", () => {
    expect(hookSecret("a secret with spaces here").ok).toBe(false);
  });
});
