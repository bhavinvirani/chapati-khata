import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { createClient } from "@supabase/supabase-js";
import { clientIp, isRateLimited, recordFailure } from "../_shared/rateLimit.ts";

// Mirrors src/lib/util.ts's normalizeName — Deno can't import from src/lib, so
// this is a hand-kept duplicate. Format characters (\p{Cf}: zero-width space,
// soft hyphen, etc.) survive trim() but not this, because names are stored
// through the same normaliser. Keep the two in step by hand.
function normalizeName(s: string): string {
  return s
    .replace(/\p{Cf}/gu, "")
    .trim()
    .toLowerCase();
}

export default {
  fetch: withSupabase({ auth: ["publishable"] }, async (req) => {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // A 4-digit code has only 10,000 combinations — with no throttle, that's
    // brute-forceable in well under a minute. Keyed by IP, not by name, so
    // several housemates on the same home network sharing one public IP
    // don't fight over a single budget the moment any of them mistypes it.
    const ip = clientIp(req);
    if (await isRateLimited("validate-access", ip)) {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }

    // ── parse body safely ──
    let name: unknown, code: unknown;
    try {
      ({ name, code } = await req.json());
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const clean = normalizeName(typeof name === "string" ? name : "");
    const codeStr = typeof code === "string" ? code : "";

    // ── validate entry code ──
    const entryCode = Deno.env.get("ENTRY_CODE");
    if (!entryCode) {
      // Fail closed: ENTRY_CODE must be configured
      return Response.json({ ok: false, error: "config" }, { status: 500 });
    }
    if (codeStr !== entryCode) {
      await recordFailure("validate-access", ip);
      return Response.json({ ok: false, error: "code" });
    }

    // ── validate name against the users table ──
    // Needs the service-role key, not the publishable one: the gate runs
    // before there is a session for RLS to authorise against.
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) {
      // Fail closed, exactly as a missing ENTRY_CODE does.
      return Response.json({ ok: false, error: "config" }, { status: 500 });
    }

    if (!clean) {
      await recordFailure("validate-access", ip);
      return Response.json({ ok: false, error: "name" });
    }

    const admin = createClient(url, serviceKey);
    const { data, error } = await admin
      .from("users")
      .select("id")
      .eq("name", clean)
      .eq("can_login", true)
      .limit(1);

    if (error) {
      return Response.json({ ok: false, error: "config" }, { status: 500 });
    }
    if (!data || data.length === 0) {
      await recordFailure("validate-access", ip);
      return Response.json({ ok: false, error: "name" });
    }

    return Response.json({ ok: true });
  }),
};
