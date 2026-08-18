// Installing the database hook: telling Postgres the shared secret, and the
// URL to send it to.
//
// Both live in Supabase Vault, which no CLI reaches. The first attempt at this
// asked the deployed `notify` function to write them, authenticated by the very
// secret being installed — which cannot converge: the running function still
// holds the previous secret, answers 401, and generating a new one just moves
// the problem along. Setup could never complete without the user choosing the
// secret by hand and pasting it into the SQL editor.
//
// `public.install_notify_hook` is an ordinary function in an exposed schema
// with `execute` granted to `service_role`, so PostgREST already offers it as
// an RPC. Calling it directly takes the edge function out of the loop
// entirely: no circular dependency, nothing to propagate first, and it works
// before the function is even deployed.

/**
 * Is this a real key, or the masked placeholder the API returns by default?
 *
 * `GET /v1/projects/{ref}/api-keys` only returns key material when asked with
 * `reveal=true`; without it, secret values come back obscured. A masked value
 * still looks like a key to `pickServiceKey`, gets sent, and is rejected —
 * which surfaced as "the key that was found is not a service key" and sent
 * someone hunting a permissions problem that did not exist. Catch it here so
 * the message names the real cause instead.
 */
export function looksMasked(key) {
  const s = String(key ?? "");
  // Legacy JWTs run to hundreds of characters and new-model keys to dozens;
  // nothing genuine is this short.
  if (s.length < 20) return true;
  // Real keys are base64url plus, for JWTs, dots. Bullets, asterisks and
  // ellipses only ever come from masking.
  return !/^[A-Za-z0-9._-]+$/.test(s);
}

/**
 * Find a key that can call a `service_role`-only RPC, from whatever shape
 * `supabase projects api-keys -o json` returned.
 *
 * Deliberately tolerant. Projects on the new key model return named secret
 * keys (`sb_secret_…`) rather than a `service_role` JWT, the field has been
 * spelled both `api_key` and `apiKey`, and a project can carry several secret
 * keys. Anything that matches is better than a correct-but-brittle read.
 */
export function pickServiceKey(payload) {
  const rows = Array.isArray(payload) ? payload : [];
  const raw = (r) => r?.api_key ?? r?.apiKey ?? r?.key ?? null;
  // A masked value is worse than none: it would be sent and rejected, and the
  // rejection reads like a permissions problem.
  const keyOf = (r) => {
    const k = raw(r);
    return k && !looksMasked(k) ? k : null;
  };

  // A legacy service_role key, named exactly that.
  const legacy = rows.find((r) => r?.name === "service_role" && keyOf(r));
  if (legacy) return keyOf(legacy);

  // A new-model secret key, recognisable by its prefix whatever it is named.
  const secret = rows.find((r) => String(keyOf(r) ?? "").startsWith("sb_secret_"));
  if (secret) return keyOf(secret);

  // Last resort: something the payload itself calls a secret.
  const typed = rows.find((r) => r?.type === "secret" && keyOf(r));
  return typed ? keyOf(typed) : null;
}

/**
 * How to present that key to PostgREST.
 *
 * A legacy key is a JWT and carries its role in the token, so it goes on both
 * headers as every Supabase client sends it. A new-model secret key is not a
 * JWT: sending it as a bearer token makes the platform try to parse it as one
 * and reject the request, so it goes on `apikey` alone.
 */
export function restHeaders(key) {
  const headers = { "Content-Type": "application/json", apikey: key };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** The project ref out of supabase/config.toml — the same one deploy.yml links. */
export function parseProjectRef(configToml) {
  const match = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(configToml ?? "");
  return match ? match[1] : null;
}

/** Where the trigger should post. Derived, so nothing has to be typed twice. */
export function notifyUrl(supabaseUrl) {
  if (!supabaseUrl) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/notify`;
}

/**
 * Turn a failed install into something a person can act on.
 *
 * Every branch names the next command, because the alternative — "install
 * failed" — leaves someone with a generated secret they were never shown and
 * no way to finish.
 */
export function installFailureHelp(kind, detail) {
  switch (kind) {
    case "no-url":
      return "set the Supabase project URL first, then re-run this setting";
    case "no-ref":
      return "supabase/config.toml has no project_id — run 'supabase link' first";
    case "no-key":
      return "could not read the project's service key — check you are logged in ('supabase login') and that your Supabase CLI is recent enough to reveal it";
    case "not-found":
      return "the database is missing install_notify_hook — deploy the migration first (push to main)";
    case "forbidden":
      return "the key that was found is not a service key — check 'supabase projects api-keys'";
    default:
      return detail || "unexpected error";
  }
}
