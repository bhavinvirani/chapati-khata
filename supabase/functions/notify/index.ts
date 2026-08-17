import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import * as webpush from "@negrel/webpush";
import { notifyText } from "../_shared/notifyText.ts";
import type { NotifiableLog } from "../_shared/notifyText.ts";

// The sender. Postgres calls this once per notifiable log row (see the
// logs_notify_push trigger), and it fans that one row out to every subscribed
// device except the actor's own.
//
// The only holder of the VAPID private key, exactly as `splitwise` is the only
// holder of the Splitwise API key.
//
// Sending is all it does. Installing the trigger's Vault rows used to live
// here too, authenticated by the very secret being installed — which could
// never converge, since a running function still holds the previous one. That
// now goes straight to `public.install_notify_hook` over PostgREST from
// `npm run config`, and this function is only ever a recipient.

/** How long a push service should hold an undelivered message. A day: a
 * chapati notification that arrives four weeks late is noise, not news. */
const TTL_SECONDS = 24 * 60 * 60;

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Constant-time string comparison.
 *
 * Postgres has no JWT to present, so this function runs with
 * `verify_jwt = false` and the `x-khata-hook` header is the whole gate —
 * which makes a naive `===`, whose runtime depends on how many leading
 * characters match, the wrong tool. Hashing first makes both inputs a fixed
 * 32 bytes, so length is not a signal either.
 */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** The VAPID keypair, as `npm run config` generated and stored it. */
function readVapidKeys(): { publicKey: JsonWebKey; privateKey: JsonWebKey } | null {
  const raw = Deno.env.get("VAPID_KEYS");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.publicKey || !parsed?.privateKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Send one message to every subscription, concurrently, and return the
 * endpoints the push service says are permanently gone.
 *
 * 404/410 mean the subscription no longer exists — the browser unsubscribed,
 * the app was deleted, site data was cleared. Anything else (a timeout, a
 * 429, a 5xx from the push service) is left alone: there is no retry queue by
 * design, and the next add or settle is the retry.
 */
async function sendAll(
  server: webpush.ApplicationServer,
  rows: SubscriptionRow[],
  payload: string,
): Promise<{ sent: number; gone: string[] }> {
  const gone: string[] = [];
  let sent = 0;

  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        const subscriber = server.subscribe({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        });
        await subscriber.pushTextMessage(payload, { ttl: TTL_SECONDS });
        sent++;
      } catch (err) {
        const status = (err as { response?: Response })?.response?.status;
        if (status === 404 || status === 410) {
          gone.push(row.endpoint);
        } else {
          // Nothing is retried, so this console line is the only record that
          // a device missed one.
          console.error("[notify] push failed", row.endpoint.slice(0, 60), status ?? err);
        }
      }
    }),
  );

  return { sent, gone };
}

export default {
  // `none` because the caller is Postgres, which has no Supabase credentials
  // to present — the signed-webhook shape from the Supabase auth guide. The
  // x-khata-hook check below is this function's entire authentication, so it
  // happens before anything else touches the body.
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const hookSecret = Deno.env.get("NOTIFY_HOOK_SECRET");
    if (!hookSecret) {
      // Fail closed, exactly as validate-access does for a missing ENTRY_CODE.
      return Response.json({ ok: false, error: "config" }, { status: 500 });
    }
    if (!(await secretsMatch(req.headers.get("x-khata-hook") ?? "", hookSecret))) {
      // No body: an unauthenticated caller learns nothing about what this is.
      return new Response(null, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    // ── the hook ──
    const log = body.log as NotifiableLog | undefined;
    if (!log || typeof log.action !== "string") {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const message = notifyText(log);
    // The trigger's `when` clause already filters, so this is belt and braces
    // — but it is also what keeps the two lists honest if one is widened.
    if (!message) return Response.json({ ok: true, sent: 0, skipped: "not_notifiable" });

    const keys = readVapidKeys();
    const subject = Deno.env.get("VAPID_SUBJECT");
    if (!keys || !subject) {
      return Response.json({ ok: false, error: "config" }, { status: 500 });
    }

    // Everyone except whoever caused this. `user_name` holds the gate name as
    // normalizeName wrote it, and so does logs.actor, so this compares like
    // with like.
    const { data, error } = await ctx.supabaseAdmin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .neq("user_name", log.actor);
    if (error) {
      console.error("[notify] could not load subscriptions", error);
      return Response.json({ ok: false, error: "db" }, { status: 500 });
    }
    const rows = (data ?? []) as SubscriptionRow[];
    if (rows.length === 0) return Response.json({ ok: true, sent: 0 });

    let server: webpush.ApplicationServer;
    try {
      server = await webpush.ApplicationServer.new({
        contactInformation: subject,
        vapidKeys: await webpush.importVapidKeys(keys, { extractable: false }),
      });
    } catch (err) {
      console.error("[notify] bad VAPID keys", err);
      return Response.json({ ok: false, error: "config" }, { status: 500 });
    }

    const payload = JSON.stringify({
      title: message.title,
      body: message.body,
      tag: message.tag,
    });
    const { sent, gone } = await sendAll(server, rows, payload);

    if (gone.length > 0) {
      const { error: pruneErr } = await ctx.supabaseAdmin
        .from("push_subscriptions")
        .delete()
        .in("endpoint", gone);
      // A failed prune is harmless: the next send hits the same 410 and tries
      // again. Worth a line in the log, not worth failing the request.
      if (pruneErr) console.error("[notify] could not prune dead endpoints", pruneErr);
    }

    return Response.json({ ok: true, sent, pruned: gone.length });
  }),
};
