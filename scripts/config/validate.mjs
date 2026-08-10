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
