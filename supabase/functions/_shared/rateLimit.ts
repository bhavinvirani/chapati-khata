import { createClient } from "@supabase/supabase-js";

// Shared by validate-access and splitwise — both are stateless between
// requests, so "how many times has this been tried recently" has to live
// somewhere durable. Only failures count (see recordFailure), so normal
// daily use — including several housemates sharing one home IP — never
// trips this; only a sustained run of wrong guesses does.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILURES = 8; // ~13 days to exhaust a 4-digit code at this rate

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY for rate limiting");
  }
  return createClient(url, serviceKey);
}

/** Best-effort real client IP, as set by Supabase's own edge gateway rather
 * than trusted verbatim from an arbitrary client-supplied header. Falls back
 * to a shared bucket if absent, which is still some protection — just less
 * granular — rather than no protection at all. */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

/**
 * Has this bucket+key already hit the failure limit in the current window?
 * Call this BEFORE doing the sensitive work, so a caller who's already over
 * the limit never even reaches the code/email check being protected.
 *
 * Fails open on a database error: this is a defense-in-depth layer on top
 * of the actual check, not the only gate, and a transient DB hiccup should
 * not lock everyone out.
 */
export async function isRateLimited(bucket: string, key: string): Promise<boolean> {
  const admin = adminClient();
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();

  const { count, error } = await admin
    .from("rate_limit_attempts")
    .select("id", { count: "exact", head: true })
    .eq("bucket", bucket)
    .eq("key", key)
    .gte("created_at", cutoff);

  if (error) return false;
  return (count ?? 0) >= MAX_FAILURES;
}

/**
 * Record one failed attempt. Only call this on an actual failure (wrong
 * code, wrong name, no match) — never on success — so legitimate repeated
 * use never contributes to the count. Also opportunistically prunes this
 * key's own attempts older than the window, keeping the table's long-term
 * size bounded without a separate cleanup job.
 */
export async function recordFailure(bucket: string, key: string): Promise<void> {
  const admin = adminClient();
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();

  await admin.from("rate_limit_attempts").insert({ bucket, key });
  await admin
    .from("rate_limit_attempts")
    .delete()
    .eq("bucket", bucket)
    .eq("key", key)
    .lt("created_at", cutoff);
}
