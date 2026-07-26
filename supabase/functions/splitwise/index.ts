import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Stateless proxy to the Splitwise API — the only thing in this project that
// holds the Splitwise API key. Needs no Supabase database access: the
// caller already knows everyone's name/email/qty/amount and sends it in the
// request body; this function's only job is talking to Splitwise. It never
// recomputes a split — the app's own entries/entry_shares invariant already
// guarantees the numbers it's given balance, and redoing that math in a
// second language (Deno can't import src/lib) is a second place for it to
// quietly drift.

const API_BASE = "https://secure.splitwise.com/api/v3.0";

// Mirrors src/lib/splitwise.ts's normalizeEmail — Deno can't import from
// src/lib (same reason validate-access hand-duplicates normalizeName). Keep
// the two in step by hand.
function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

interface SplitwiseMember {
  id: number;
  email: string;
}

async function splitwiseFetch(
  path: string,
  apiKey: string,
  params?: Record<string, string>,
): Promise<any> {
  const isGet = path.startsWith("get_");
  let url = `${API_BASE}/${path}`;
  const init: RequestInit = { headers: { Authorization: `Bearer ${apiKey}` } };
  if (isGet) {
    if (params && Object.keys(params).length > 0) {
      url += "?" + new URLSearchParams(params).toString();
    }
    init.method = "GET";
  } else {
    init.method = "POST";
    init.headers = { ...init.headers, "Content-Type": "application/x-www-form-urlencoded" };
    init.body = new URLSearchParams(params ?? {}).toString();
  }
  const res = await fetch(url, init);
  // Splitwise itself warns that 200 OK doesn't mean success (bodies carry
  // the real errors object regardless of status), so we intentionally don't
  // gate on res.ok here — a non-2xx with a parseable JSON body still needs
  // to reach the existing json.errors handling below, not get collapsed
  // into a generic network failure. A non-JSON body (gateway timeout page,
  // empty response, etc.) still throws via res.json() itself, which every
  // call site already wraps in try/catch.
  return res.json();
}

async function groupMembers(apiKey: string, groupId: string): Promise<SplitwiseMember[]> {
  const json = await splitwiseFetch(`get_group/${groupId}`, apiKey);
  const members = (json.group?.members ?? []) as { id: number; email: string }[];
  return members.map((m) => ({ id: m.id, email: normalizeEmail(m.email ?? "") }));
}

async function resolveCategoryId(apiKey: string, name: string): Promise<number | null> {
  const json = await splitwiseFetch("get_categories", apiKey);
  const categories = (json.categories ?? []) as {
    id: number;
    name: string;
    subcategories?: { id: number; name: string }[];
  }[];
  const target = name.toLowerCase();
  for (const c of categories) {
    if (c.name.toLowerCase() === target) return c.id;
    for (const sub of c.subcategories ?? []) {
      if (sub.name.toLowerCase() === target) return sub.id;
    }
  }
  return null;
}

async function handleLink(apiKey: string, groupId: string, body: Record<string, unknown>) {
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!email) return Response.json({ linked: false });
  let members: SplitwiseMember[];
  try {
    members = await groupMembers(apiKey, groupId);
  } catch {
    // Can't confirm membership without the group — fail closed the same way
    // a genuine non-match does, rather than an unhandled exception. The
    // caller only ever branches on `linked`, so this stays within the
    // action's existing response contract instead of introducing a new
    // shape it wasn't built to expect.
    return Response.json({ linked: false });
  }
  const match = members.find((m) => m.email === email);
  if (!match) return Response.json({ linked: false });
  return Response.json({ linked: true, splitwise_user_id: String(match.id) });
}

async function handlePush(apiKey: string, groupId: string, body: Record<string, unknown>) {
  const payerEmail = typeof body.payerEmail === "string" ? body.payerEmail : "";
  const people = Array.isArray(body.people)
    ? (body.people as { name: string; email: string; qty: number; amount: number }[])
    : [];
  const totalCost = typeof body.totalCost === "number" ? body.totalCost : NaN;
  const description = typeof body.description === "string" ? body.description : "";
  const date = typeof body.date === "string" ? body.date : "";

  if (!payerEmail || people.length === 0 || !Number.isFinite(totalCost) || !description || !date) {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const sum = Math.round(people.reduce((s, p) => s + p.amount, 0) * 100);
  if (sum !== Math.round(totalCost * 100)) {
    return Response.json({ ok: false, error: "amount_mismatch" });
  }

  let members: SplitwiseMember[];
  try {
    members = await groupMembers(apiKey, groupId);
  } catch {
    return Response.json({ ok: false, error: "network" }, { status: 502 });
  }
  const byEmail = new Map(members.map((m) => [m.email, m.id]));

  const missing: string[] = [];
  const resolved = people.map((p) => {
    const id = byEmail.get(normalizeEmail(p.email));
    if (!id) missing.push(p.name);
    return { ...p, splitwiseId: id };
  });
  const payerId = byEmail.get(normalizeEmail(payerEmail));
  if (!payerId) missing.push(payerEmail);
  if (missing.length > 0) {
    return Response.json({ ok: false, error: "not_linked", detail: missing.join(", ") });
  }

  // The payer may have fronted the cost for a week they personally ordered
  // nothing (a real, design-intended case) — they then have no entry in
  // people[] at all. Splitwise still needs a users__N__ entry for them so
  // paid_share sums to the total; add a synthetic zero-owed one if they're
  // not already present as one of the people with a share.
  if (!resolved.some((p) => p.splitwiseId === payerId)) {
    resolved.push({ name: "payer", email: payerEmail, qty: 0, amount: 0, splitwiseId: payerId });
  }

  // Mirrors src/config.ts's SPLITWISE_CATEGORY_NAME — Deno can't import from
  // src/config (same hand-duplication reason as normalizeEmail above). Keep
  // the two in step by hand.
  let categoryId: number | null;
  try {
    categoryId = await resolveCategoryId(apiKey, "Groceries");
  } catch {
    return Response.json({ ok: false, error: "network" }, { status: 502 });
  }

  const params: Record<string, string> = {
    cost: totalCost.toFixed(2),
    group_id: groupId,
    description,
    date,
    // Mirrors src/config.ts's SPLITWISE_CURRENCY — same hand-duplication
    // reason as normalizeEmail above. Keep the two in step by hand.
    currency_code: "CAD",
  };
  if (categoryId !== null) params.category_id = String(categoryId);
  resolved.forEach((p, i) => {
    params[`users__${i}__user_id`] = String(p.splitwiseId);
    params[`users__${i}__paid_share`] = p.splitwiseId === payerId ? totalCost.toFixed(2) : "0.00";
    params[`users__${i}__owed_share`] = p.amount.toFixed(2);
  });

  let json: { expenses?: { id: number }[]; errors?: Record<string, unknown> };
  try {
    json = await splitwiseFetch("create_expense", apiKey, params);
  } catch {
    return Response.json({ ok: false, error: "network" }, { status: 502 });
  }

  // "200 OK does not indicate a successful response" — success means an
  // empty errors object AND a returned expense, not just a 200.
  if (json.errors && Object.keys(json.errors).length > 0) {
    return Response.json({ ok: false, error: "splitwise", detail: JSON.stringify(json.errors) });
  }
  const expense = json.expenses?.[0];
  if (!expense) {
    return Response.json({ ok: false, error: "no_expense" });
  }
  return Response.json({ ok: true, expense_id: String(expense.id) });
}

async function handleDelete(apiKey: string, body: Record<string, unknown>) {
  const expenseId = typeof body.expense_id === "string" ? body.expense_id : "";
  if (!expenseId) return Response.json({ ok: false, error: "bad_request" }, { status: 400 });

  let json: { success?: boolean; errors?: Record<string, unknown> };
  try {
    json = await splitwiseFetch(`delete_expense/${expenseId}`, apiKey, {});
  } catch {
    return Response.json({ ok: false, error: "network" }, { status: 502 });
  }
  if (json.success) return Response.json({ ok: true });

  // Splitwise's delete is a soft delete (expenses carry deleted_at) — if
  // it's already gone, that's the goal state already reached, not a failure.
  try {
    const getJson = (await splitwiseFetch(`get_expense/${expenseId}`, apiKey)) as {
      expense?: { deleted_at?: string | null };
    };
    if (!getJson.expense || getJson.expense.deleted_at) {
      return Response.json({ ok: true });
    }
  } catch {
    return Response.json({ ok: false, error: "network" }, { status: 502 });
  }
  return Response.json({ ok: false, error: "splitwise", detail: JSON.stringify(json.errors ?? {}) });
}

export default {
  // "user" requires a real authenticated Supabase session (anonymous
  // sign-in counts) — the same trust boundary RLS already applies to every
  // table in this project, and the actual gate here: no session, no response.
  fetch: withSupabase({ auth: ["user"] }, async (req) => {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const apiKey = Deno.env.get("SPLITWISE_API_KEY");
    const groupId = Deno.env.get("SPLITWISE_GROUP_ID");
    if (!apiKey || !groupId) {
      return Response.json({ ok: false, error: "config" }, { status: 500 });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    switch (body.action) {
      case "link":
        return handleLink(apiKey, groupId, body);
      case "push":
        return handlePush(apiKey, groupId, body);
      case "delete":
        return handleDelete(apiKey, body);
      default:
        return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
  }),
};
