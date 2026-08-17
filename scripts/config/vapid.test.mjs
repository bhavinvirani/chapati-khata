import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { applicationServerKey, generateVapidKeys, randomSecret } from "./vapid.mjs";

const subtle = webcrypto.subtle;

describe("generateVapidKeys", () => {
  it("produces a P-256 JWK pair", () => {
    const { keys } = generateVapidKeys();
    expect(keys.publicKey).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(keys.privateKey).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(keys.publicKey.d).toBeUndefined();
    expect(typeof keys.privateKey.d).toBe("string");
  });

  it("never puts the private half in the application server key", () => {
    const { keys, applicationServerKey: k } = generateVapidKeys();
    // The browser gets only x and y; d must never leave the JWK secret.
    expect(k).not.toContain(keys.privateKey.d);
  });

  it("is a different pair every time", () => {
    const a = generateVapidKeys();
    const b = generateVapidKeys();
    expect(a.applicationServerKey).not.toBe(b.applicationServerKey);
  });

  // These are the checks that matter: the same WebCrypto calls
  // @negrel/webpush makes on the keys, run against what this generated. If
  // the JWK shape were wrong, the notify function would fail at runtime on a
  // phone rather than here.
  describe("imports through WebCrypto the way the sender does", () => {
    it("imports the public key for verifying", async () => {
      const { keys } = generateVapidKeys();
      const key = await subtle.importKey(
        "jwk",
        keys.publicKey,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      );
      expect(key.type).toBe("public");
    });

    it("imports the private key for signing", async () => {
      const { keys } = generateVapidKeys();
      const key = await subtle.importKey(
        "jwk",
        keys.privateKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      expect(key.type).toBe("private");
    });

    it("signs and verifies as a matching pair", async () => {
      const { keys } = generateVapidKeys();
      const alg = { name: "ECDSA", namedCurve: "P-256" };
      const priv = await subtle.importKey("jwk", keys.privateKey, alg, false, ["sign"]);
      const pub = await subtle.importKey("jwk", keys.publicKey, alg, true, ["verify"]);
      const data = new TextEncoder().encode("a VAPID JWT would go here");
      const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, data);
      expect(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, data)).toBe(true);
    });

    it("derives the same application server key WebCrypto exports as raw", async () => {
      const { keys, applicationServerKey: derived } = generateVapidKeys();
      const pub = await subtle.importKey(
        "jwk",
        keys.publicKey,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      );
      const raw = Buffer.from(await subtle.exportKey("raw", pub));
      expect(raw.length).toBe(65);
      expect(raw[0]).toBe(0x04);
      expect(raw.toString("base64url")).toBe(derived);
    });
  });

  it("yields a key the browser can decode back to 65 bytes", () => {
    const { applicationServerKey: k } = generateVapidKeys();
    // base64url: no +, /, or padding, or pushManager.subscribe rejects it.
    expect(k).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(k, "base64url").length).toBe(65);
  });
});

describe("applicationServerKey", () => {
  it("refuses coordinates that are not a P-256 point", () => {
    expect(() =>
      applicationServerKey({ x: Buffer.alloc(31).toString("base64url"), y: "AAAA" }),
    ).toThrow(/32-byte/);
  });
});

describe("randomSecret", () => {
  it("is url-safe, so it survives a header and a Vault round trip", () => {
    expect(randomSecret()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("carries 32 bytes of entropy by default", () => {
    expect(Buffer.from(randomSecret(), "base64url").length).toBe(32);
  });

  it("is different every time", () => {
    expect(randomSecret()).not.toBe(randomSecret());
  });
});
