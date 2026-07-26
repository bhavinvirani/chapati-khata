import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { createClient } from "@supabase/supabase-js";

export default {
  fetch: withSupabase({ auth: ["publishable"] }, async (req) => {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // ── parse body safely ──
    let name: unknown, code: unknown;
    try {
      ({ name, code } = await req.json());
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const clean = (typeof name === "string" ? name : "").trim().toLowerCase();
    const codeStr = typeof code === "string" ? code : "";

    // ── validate entry code ──
    const entryCode = Deno.env.get("ENTRY_CODE");
    if (!entryCode) {
      // Fail closed: ENTRY_CODE must be configured
      return Response.json({ ok: false, error: "config" }, { status: 500 });
    }
    if (codeStr !== entryCode) {
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
      return Response.json({ ok: false, error: "name" });
    }

    return Response.json({ ok: true });
  }),
};
