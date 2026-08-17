import { generateKeyPairSync, randomBytes } from "node:crypto";

// VAPID keypair generation, in Node, with no dependencies.
//
// A VAPID key is an ECDSA P-256 keypair (RFC 8292), and this project needs it
// in two shapes at once:
//
//   * the sender (`@negrel/webpush`, in the notify edge function) imports and
//     exports keys as JWK, so the pair is stored as one JSON secret;
//   * the browser's `pushManager.subscribe` wants `applicationServerKey`: the
//     public key as a raw uncompressed point, `0x04 || x || y`, base64url.
//
// Both come out of one generation, which is why `vapid-public-key` in the
// registry fills `vapid-keys` alongside itself rather than the two being asked
// for separately.

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/**
 * The raw 65-byte uncompressed point a browser subscribes with, derived from
 * the public JWK's coordinates.
 */
export function applicationServerKey(publicJwk) {
  const x = Buffer.from(publicJwk.x, "base64url");
  const y = Buffer.from(publicJwk.y, "base64url");
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`expected 32-byte P-256 coordinates, got ${x.length}/${y.length}`);
  }
  return b64url(Buffer.concat([Buffer.from([0x04]), x, y]));
}

/**
 * A fresh VAPID keypair.
 *
 * Returns the JWK pair exactly as the sender imports it, and the base64url
 * application server key the frontend ships. Only the standard EC members are
 * kept — Node adds nothing harmful, but a leaner JWK is one less thing for
 * WebCrypto's import to object to.
 */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });

  const keys = {
    publicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y },
    privateKey: { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d },
  };
  return { keys, applicationServerKey: applicationServerKey(keys.publicKey) };
}

/** A random shared secret, for the trigger-to-function hook. */
export function randomSecret(bytes = 32) {
  return b64url(randomBytes(bytes));
}
