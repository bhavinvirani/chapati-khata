import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

// Injected by Supabase into every project's function environment. Not ours to
// edit, and not strays.
const PLATFORM_MANAGED = new Set([
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_JWKS",
  "SUPABASE_PUBLISHABLE_KEYS",
  "SUPABASE_SECRET_KEYS",
  "SUPABASE_SERVICE_ROLE_KEY",
]);

export function isPlatformManaged(name) {
  return PLATFORM_MANAGED.has(name);
}

/** `supabase secrets list` returns sha256(plaintext), never the plaintext. */
export function digestMatches(digest, plaintext) {
  if (!digest) return false;
  return digest === createHash("sha256").update(String(plaintext)).digest("hex");
}

export const id = "supabase";
export const label = "Supabase secrets";
export const effect = "immediate";

let cache = null; // Map<name, { updatedAt, digest }>, one fetch per run

async function fetchSecrets() {
  if (cache) return cache;
  const { stdout } = await run("supabase", ["secrets", "list", "-o", "json"]);
  cache = new Map(
    JSON.parse(stdout).map((s) => [s.name, { updatedAt: s.updated_at, digest: s.value }]),
  );
  return cache;
}

export async function probe() {
  try {
    await run("supabase", ["--version"]);
  } catch {
    return {
      available: false,
      reason: "Supabase CLI not installed — see supabase.com/docs/guides/cli",
    };
  }
  try {
    await fetchSecrets();
    return { available: true };
  } catch (err) {
    const text = `${err.stderr ?? ""}${err.message ?? ""}`;
    if (/not logged in|access token|login/i.test(text)) {
      return { available: false, reason: "not logged in — run 'supabase login'" };
    }
    if (/not linked|link your project|project ref/i.test(text)) {
      return { available: false, reason: "project not linked — run 'supabase link'" };
    }
    return {
      available: false,
      reason: text.trim().split("\n")[0] || "supabase secrets list failed",
    };
  }
}

export async function list() {
  return [...(await fetchSecrets()).keys()].filter((n) => !isPlatformManaged(n));
}

export async function read(key) {
  const found = (await fetchSecrets()).get(key);
  if (!found) return { known: false, present: false };
  return { known: false, present: true, updatedAt: found.updatedAt, digest: found.digest };
}

export async function write(key, value) {
  // `supabase secrets set KEY=VALUE` would put the secret in argv, where any
  // other user on the machine can read it out of `ps`. --env-file does not.
  const dir = await mkdtemp(join(tmpdir(), "chapati-config-"));
  const file = join(dir, "secrets.env");
  try {
    await writeFile(file, `${key}=${value}\n`, { encoding: "utf8", mode: 0o600 });
    await run("supabase", ["secrets", "set", "--env-file", file]);
    cache = null; // force a re-read so status reflects the new digest
  } finally {
    await unlink(file).catch(() => {});
  }
}
