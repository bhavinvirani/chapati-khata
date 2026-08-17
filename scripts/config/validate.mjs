// Every validator takes raw input and returns either
//   { ok: true, value, warn? }   — `warn` means print it and continue
//   { ok: false, reason }        — re-prompt with `reason`

const clean = (raw) => String(raw ?? "").trim();

export function positiveNumber(raw) {
  const n = Number(clean(raw));
  if (clean(raw) === "" || !Number.isFinite(n) || n <= 0) {
    return { ok: false, reason: "must be a number greater than 0" };
  }
  return { ok: true, value: n };
}

export function currencySymbol(raw) {
  const s = clean(raw);
  if (s.length < 1 || s.length > 3) return { ok: false, reason: "must be 1–3 characters" };
  if (/\s/.test(s)) return { ok: false, reason: "must not contain spaces" };
  return { ok: true, value: s };
}

export function currencyCode(raw) {
  const s = clean(raw).toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) return { ok: false, reason: "must be a 3-letter code like CAD" };
  return { ok: true, value: s };
}

export function nonEmpty(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, reason: "must not be empty" };
  return { ok: true, value: s };
}

export function token(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, reason: "must not be empty" };
  if (/\s/.test(s)) return { ok: false, reason: "must not contain spaces" };
  return { ok: true, value: s };
}

export function fourDigits(raw) {
  const s = clean(raw);
  if (!/^\d{4}$/.test(s)) return { ok: false, reason: "must be exactly 4 digits" };
  return { ok: true, value: s };
}

export function groupId(raw) {
  const s = clean(raw);
  if (!/^\d+$/.test(s)) {
    return {
      ok: false,
      reason: "must be digits only — just the number from the group's URL, not the whole URL",
    };
  }
  return { ok: true, value: s };
}

export function supabaseUrl(raw) {
  const s = clean(raw).replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(s)) {
    return { ok: false, reason: "must look like https://<project-ref>.supabase.co" };
  }
  return { ok: true, value: s };
}

export function anonKey(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, reason: "must not be empty" };
  if (/\s/.test(s)) return { ok: false, reason: "must not contain spaces" };
  const known = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(s) || /^sb_publishable_[\w-]+$/.test(s);
  if (known) return { ok: true, value: s };
  return {
    ok: true,
    value: s,
    warn: "that doesn't look like a JWT or an sb_publishable_ key — continuing anyway, the live check will confirm it",
  };
}

/** The VAPID subject: who to contact about pushes from this app (RFC 8292). */
export function contactUri(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, reason: "must not be empty" };
  if (/\s/.test(s)) return { ok: false, reason: "must not contain spaces" };
  if (!/^(mailto:\S+@\S+\.\S+|https:\/\/\S+)$/.test(s)) {
    return { ok: false, reason: "must be a mailto: address or an https:// URL" };
  }
  return { ok: true, value: s };
}

/**
 * The VAPID public key as the browser subscribes with it: a raw uncompressed
 * P-256 point, base64url. Checked by decoding rather than by pattern, since
 * a key of the right shape but the wrong length fails silently at
 * `pushManager.subscribe` with an error nobody can act on.
 */
export function vapidPublicKey(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, reason: "must not be empty" };
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    return { ok: false, reason: "must be base64url — no +, / or = padding" };
  }
  const bytes = Buffer.from(s, "base64url");
  if (bytes.length !== 65) {
    return { ok: false, reason: `must decode to 65 bytes, this one is ${bytes.length}` };
  }
  if (bytes[0] !== 0x04) {
    return { ok: false, reason: "must start with 0x04 (an uncompressed P-256 point)" };
  }
  return { ok: true, value: s };
}

/** The keypair as the notify function imports it: {publicKey, privateKey} JWKs. */
export function vapidKeys(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, reason: "must not be empty" };
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    return { ok: false, reason: "must be JSON — generate it rather than typing it" };
  }
  const { publicKey, privateKey } = parsed ?? {};
  if (!publicKey || !privateKey) {
    return { ok: false, reason: "must have both a publicKey and a privateKey" };
  }
  for (const [name, jwk] of [
    ["publicKey", publicKey],
    ["privateKey", privateKey],
  ]) {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
      return { ok: false, reason: `${name} must be an EC P-256 JWK` };
    }
  }
  if (!privateKey.d) return { ok: false, reason: "privateKey is missing its private part (d)" };
  if (publicKey.d) return { ok: false, reason: "publicKey must not carry a private part (d)" };
  return { ok: true, value: JSON.stringify(parsed) };
}

/** The shared secret the logs trigger presents to the notify function. */
export function hookSecret(raw) {
  const s = clean(raw);
  if (!s) return { ok: false, reason: "must not be empty" };
  if (/\s/.test(s)) return { ok: false, reason: "must not contain spaces" };
  if (s.length < 16) return { ok: false, reason: "must be at least 16 characters" };
  return { ok: true, value: s };
}
