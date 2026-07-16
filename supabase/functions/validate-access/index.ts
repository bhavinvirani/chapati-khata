import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

export default {
  fetch: withSupabase({ auth: ["publishable"] }, async (req) => {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const { name, code } = await req.json();
    const clean = (name ?? "").trim().toLowerCase();

    // ── validate entry code (skip if ENTRY_CODE secret is not set) ──
    const entryCode = Deno.env.get("ENTRY_CODE");
    if (entryCode && code !== entryCode) {
      return Response.json({ ok: false, error: "code" });
    }

    // ── validate name against allowlist ──
    // Set ALLOWED_NAMES secret as comma-separated: "bhavin,abhishek,deven"
    const allowedRaw = Deno.env.get("ALLOWED_NAMES") ?? "";
    const allowed = allowedRaw
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);

    if (allowed.length > 0 && !allowed.includes(clean)) {
      return Response.json({ ok: false, error: "name" });
    }

    // both valid (or not configured — allow through)
    return Response.json({ ok: true });
  }),
};
