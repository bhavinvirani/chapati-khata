import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

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

    // ── validate name against allowlist ──
    // Set ALLOWED_NAMES secret as comma-separated: "bhavin,abhishek,deven"
    const allowedRaw = Deno.env.get("ALLOWED_NAMES") ?? "";
    const allowed = allowedRaw
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);

    if (allowed.length === 0) {
      // Fail closed: ALLOWED_NAMES must be configured
      return Response.json({ ok: false, error: "config" }, { status: 500 });
    }

    if (!clean || !allowed.includes(clean)) {
      return Response.json({ ok: false, error: "name" });
    }

    return Response.json({ ok: true });
  }),
};
