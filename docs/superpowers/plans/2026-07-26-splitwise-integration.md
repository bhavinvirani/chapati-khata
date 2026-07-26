# Splitwise Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a week (or a batch settled together) is marked paid in Chapati Khata, let the group push one matching expense to the real Splitwise group instead of typing it in by hand.

**Architecture:** A new `settlements` table groups whichever weeks were paid together in one Mark Paid / Settle All click — that settlement is the pushable unit, one Splitwise expense each. A new stateless edge function (`supabase/functions/splitwise`) is the only thing that ever talks to the Splitwise API, holding the API key and group id as secrets the browser never sees. The client computes and already guarantees every number involved (via the existing `entries`/`entry_shares` invariant); the edge function forwards those numbers rather than recomputing them.

**Tech Stack:** React + TypeScript + Vite frontend, Supabase (Postgres/PostgREST/Realtime/Edge Functions, Deno), vitest for pure-function tests.

## Global Constraints

- Design of record: `docs/superpowers/specs/2026-07-26-splitwise-integration-design.md` — every task below implements a specific section of it; cite the section in review.
- Migration filenames must match `<14-digit-timestamp>_name.sql` (CI regex-checks this).
- CI fails on `DROP TABLE/COLUMN/SCHEMA/EXTENSION`, `TRUNCATE`, `DELETE FROM`, or a column type change without a `-- allow-destructive` comment. This feature's migration is additive-only (new table, new nullable columns) and needs no such marker.
- `supabase/functions/**` is excluded from `eslint`, `prettier`, and `tsc` — it's Deno, owned by `deno fmt`/`deno lint` conventions, not the frontend toolchain. Don't try to run frontend lint/typecheck against it.
- Vitest runs in a `node` environment, no `jsdom` — only pure functions in `src/lib` get unit tests here. Components (`PeopleSheet.tsx`, `WeekCard.tsx`, etc.) and `src/lib/db.ts` have no test files anywhere in this codebase today; this plan follows that existing convention rather than introducing a new one.
- Default to no comments; add one only where it states a non-obvious *why* (a constraint, an invariant, a specific failure mode being guarded against) — matching every existing file's style in this codebase.
- Currency is fixed as `"CAD"`. The expense description is `Roti <date range>` (e.g. `Roti Jul 6 – 19`). The category is resolved by name (`"Groceries"`) at push time via Splitwise's `get_categories`, never a hardcoded numeric id (Splitwise's ids for this aren't something this plan can verify in advance, and resolving by name is one extra cheap API call instead of a guess that could be silently wrong).
- The Splitwise API key that appeared earlier in this conversation must be rotated before it's used as a secret — treat the value already shared as burned.
- Commit after each task's steps are green, using this repo's existing commit style (short, lowercase, `type: summary`).

---

## Task 1: Database migration + schema.sql sync

**Files:**
- Create: `supabase/migrations/20260726140000_splitwise.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: table `public.settlements` (columns: `id uuid`, `created_at timestamptz`, `actor text`, `device_id text`, `splitwise_payer_user_id uuid`, `splitwise_expense_id text`, `splitwise_status text`, `splitwise_pushed_at timestamptz`); `public.weeks.settlement_id uuid`; `public.users.splitwise_email text`; `public.users.splitwise_user_id text`. Every later task that touches the database depends on these existing.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260726140000_splitwise.sql`:

```sql
-- Splitwise integration: a settlement groups whichever week(s) were paid
-- together in one Mark Paid / Settle All click, and becomes the pushable
-- unit — one Splitwise expense per settlement, however many weeks it
-- covers. See docs/superpowers/specs/2026-07-26-splitwise-integration-design.md.

create table public.settlements (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  actor                   text not null,
  device_id               text,
  -- restrict, not cascade: a settlement is a real record of who fronted
  -- money, and "a person with history cannot be deleted" should hold here
  -- the same way it holds for entry_shares.
  splitwise_payer_user_id uuid references public.users(id) on delete restrict,
  splitwise_expense_id    text,
  -- null means "never pushed, or last attempt failed cleanly"; 'unknown'
  -- means the last attempt's outcome couldn't be determined (e.g. a
  -- timeout) and a silent retry is not safe.
  splitwise_status        text check (splitwise_status in ('unknown')),
  splitwise_pushed_at     timestamptz
);

alter table public.weeks
  add column settlement_id uuid references public.settlements(id) on delete restrict;
create index weeks_settlement_idx on public.weeks(settlement_id);

alter table public.users add column splitwise_email   text;
alter table public.users add column splitwise_user_id text;

alter table public.settlements enable row level security;
create policy "authed all - settlements" on public.settlements
  for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.settlements to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'settlements'
  ) then
    alter publication supabase_realtime add table public.settlements;
  end if;
end $$;
```

- [ ] **Step 2: Update `supabase/schema.sql` to match, for fresh installs**

In `supabase/schema.sql`, immediately after the closing `);` of the `public.users` table definition (right before the `-- ── the per-person breakdown ──` comment that precedes `entry_shares`), insert:

```sql

-- ── settlements: one row per Mark Paid / Settle All click, whatever weeks
-- it covers — the pushable unit for the Splitwise integration. ──
create table if not exists public.settlements (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  actor                   text not null,
  device_id               text,
  splitwise_payer_user_id uuid references public.users(id) on delete restrict,
  splitwise_expense_id    text,
  splitwise_status        text check (splitwise_status in ('unknown')),
  splitwise_pushed_at     timestamptz
);

alter table public.weeks
  add column if not exists settlement_id uuid references public.settlements(id) on delete restrict;
create index if not exists weeks_settlement_idx on public.weeks(settlement_id);

alter table public.users add column if not exists splitwise_email   text;
alter table public.users add column if not exists splitwise_user_id text;
```

In the RLS section, add alongside the four existing `drop policy if exists` lines:

```sql
drop policy if exists "authed all - settlements" on public.settlements;
```

and alongside the five `create policy "authed all - ..."` lines:

```sql
create policy "authed all - settlements" on public.settlements for all to authenticated using (true) with check (true);
```

In the grants line (`grant select, insert, update, delete on public.weeks, public.entries, ...`), add `public.settlements` to the list.

In the realtime `do $$ ... end $$` block, add a fifth guarded block matching the existing four, for `settlements`:

```sql
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'settlements'
  ) then
    alter publication supabase_realtime add table public.settlements;
  end if;
```

- [ ] **Step 3: Apply the migration against the test project and verify**

Run: `supabase link --project-ref txsxfhfepwaxpujqxako && supabase db push --linked --yes`
Expected: migration applies with no errors; `supabase db push --linked --dry-run` afterward reports nothing pending.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260726140000_splitwise.sql supabase/schema.sql
git commit -m "feat: add settlements table for Splitwise integration"
```

---

## Task 2: Types and config constants

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Settlement` interface; `User.splitwise_email: string | null`, `User.splitwise_user_id: string | null`; `Week.settlement_id: string | null`; `WeekView.settlement: Settlement | null`; `LogAction` gains `"splitwise_push" | "splitwise_unpush"`; `SPLITWISE_CURRENCY: string`, `SPLITWISE_CATEGORY_NAME: string` in `src/config.ts`.

- [ ] **Step 1: Extend `src/types.ts`**

Add the `Settlement` interface right after the `User` interface:

```ts
export interface Settlement {
  id: string; // uuid
  created_at: string; // ISO timestamp
  actor: string;
  device_id: string | null;
  splitwise_payer_user_id: string | null;
  splitwise_expense_id: string | null;
  splitwise_status: "unknown" | null;
  splitwise_pushed_at: string | null;
}
```

Update the `User` interface to add two fields:

```ts
export interface User {
  id: string; // uuid
  name: string; // lowercase, unique
  in_split: boolean; // appears in the split composer
  can_login: boolean; // passes the gate
  created_at: string; // ISO timestamp — also the composer's row order
  splitwise_email: string | null; // what's typed in the People sheet
  splitwise_user_id: string | null; // resolved id from the last successful link check — a UI hint only, never trusted at push time
}
```

Update the `Week` interface to add `settlement_id`:

```ts
export interface Week {
  week_start: string; // 'YYYY-MM-DD' (Monday) — primary key
  paid: boolean;
  paid_at: string | null; // ISO timestamp
  settlement_id: string | null; // FK -> settlements.id, null for weeks paid before this feature or never paid
}
```

Update `LogAction`:

```ts
export type LogAction =
  | "create"
  | "add"
  | "edit"
  | "delete"
  | "paid"
  | "reopen"
  | "login"
  | "user_add"
  | "user_delete"
  | "user_split_on"
  | "user_split_off"
  | "user_login_on"
  | "user_login_off"
  | "splitwise_push"
  | "splitwise_unpush";
```

Update `WeekView` to carry the resolved settlement:

```ts
export interface WeekView extends Week {
  entries: Entry[];
  total: number;
  count: number;
  settlement: Settlement | null;
}
```

- [ ] **Step 2: Add config constants**

In `src/config.ts`, after the existing `CURRENCY` line:

```ts
export const SPLITWISE_CURRENCY = "CAD";
export const SPLITWISE_CATEGORY_NAME = "Groceries";
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: fails right now with errors in `src/lib/aggregate.test.ts`/callers that construct a `Week`/`User` object without the new required fields — that's expected; those get fixed in later tasks that touch each file. Confirm the *only* new errors are missing-property errors on `Week`/`User`/`WeekView` literals, not something unrelated.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/config.ts
git commit -m "feat: add Settlement type and Splitwise config constants"
```

---

## Task 3: Pure Splitwise helper functions

**Files:**
- Modify: `src/lib/util.ts`
- Modify: `src/lib/util.test.ts`
- Create: `src/lib/splitwise.ts`
- Create: `src/lib/splitwise.test.ts`

**Interfaces:**
- Consumes: `PersonTotal` from `src/lib/aggregate.ts` (`{ userId: string; qty: number; amount: number }`), `User` from `src/types.ts`.
- Produces: `dateRangeLabel(start: Date, end: Date, withYear?: boolean): string` (exported from `util.ts`); `settlementLabel(weekIds: string[]): string`, `normalizeEmail(email: string): string`, `missingSplitwiseLinks(totals: PersonTotal[], users: User[]): string[]`, `SplitwisePerson` interface (`{ name: string; email: string; qty: number; amount: number }`), `buildSplitwisePeople(totals: PersonTotal[], users: User[]): SplitwisePerson[] | null` — all from `src/lib/splitwise.ts`. Later tasks (db.ts, App.tsx, WeekCard.tsx) call these by these exact names.

- [ ] **Step 1: Refactor `weekLabel` to expose a reusable date-range formatter**

In `src/lib/util.ts`, replace the existing `weekLabel` function:

```ts
/** "Jul 13 – 19" or "Jun 30 – Jul 6" (year only when asked). */
export function weekLabel(weekId: string, withYear = false): string {
  const mon = parseYMD(weekId);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  const y = withYear ? `, ${mon.getFullYear()}` : "";
  if (mon.getMonth() === sun.getMonth())
    return `${MON[mon.getMonth()]} ${mon.getDate()} – ${sun.getDate()}${y}`;
  return `${MON[mon.getMonth()]} ${mon.getDate()} – ${MON[sun.getMonth()]} ${sun.getDate()}${y}`;
}
```

with:

```ts
/** "Jul 13 – 19" or "Jun 30 – Jul 6" (year only when asked). Shared by
 * weekLabel (a fixed 7-day span) and the Splitwise settlement label (an
 * arbitrary span across one or more weeks). */
export function dateRangeLabel(start: Date, end: Date, withYear = false): string {
  const y = withYear ? `, ${start.getFullYear()}` : "";
  if (start.getMonth() === end.getMonth())
    return `${MON[start.getMonth()]} ${start.getDate()} – ${end.getDate()}${y}`;
  return `${MON[start.getMonth()]} ${start.getDate()} – ${MON[end.getMonth()]} ${end.getDate()}${y}`;
}

/** "Jul 13 – 19" or "Jun 30 – Jul 6" (year only when asked). */
export function weekLabel(weekId: string, withYear = false): string {
  const mon = parseYMD(weekId);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  return dateRangeLabel(mon, sun, withYear);
}
```

- [ ] **Step 2: Add a test for `dateRangeLabel` and verify `weekLabel` still behaves**

Add to `src/lib/util.test.ts`:

```ts
import { dateRangeLabel, normalizeName, weekLabel } from "./util";

describe("dateRangeLabel", () => {
  it("formats a same-month range", () => {
    expect(dateRangeLabel(new Date(2026, 6, 13), new Date(2026, 6, 19))).toBe("Jul 13 – 19");
  });

  it("formats a cross-month range", () => {
    expect(dateRangeLabel(new Date(2026, 5, 30), new Date(2026, 6, 6))).toBe("Jun 30 – Jul 6");
  });

  it("appends the year only when asked", () => {
    expect(dateRangeLabel(new Date(2026, 6, 13), new Date(2026, 6, 19), true)).toBe("Jul 13 – 19, 2026");
  });
});

describe("weekLabel", () => {
  it("still formats a week's own Monday-to-Sunday span", () => {
    expect(weekLabel("2026-07-13")).toBe("Jul 13 – 19");
  });
});
```

(Change the existing top import line from `import { normalizeName } from "./util";` to include the new names, as shown above.)

- [ ] **Step 3: Run tests, verify pass**

Run: `npm run test -- util.test.ts`
Expected: all tests pass, including the pre-existing `normalizeName` ones.

- [ ] **Step 4: Write the failing tests for `src/lib/splitwise.ts`**

Create `src/lib/splitwise.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PersonTotal } from "./aggregate";
import type { User } from "../types";
import {
  buildSplitwisePeople,
  missingSplitwiseLinks,
  normalizeEmail,
  settlementLabel,
} from "./splitwise";

function user(over: Partial<User> = {}): User {
  return {
    id: "u1",
    name: "bhavin",
    in_split: true,
    can_login: true,
    created_at: "2026-01-01T00:00:00Z",
    splitwise_email: null,
    splitwise_user_id: null,
    ...over,
  };
}

function total(userId: string, qty: number, amount: number): PersonTotal {
  return { userId, qty, amount };
}

describe("settlementLabel", () => {
  it("labels a single week", () => {
    expect(settlementLabel(["2026-07-06"])).toBe("Roti Jul 6 – 12");
  });

  it("spans from the earliest week's Monday to the latest week's Sunday", () => {
    expect(settlementLabel(["2026-07-13", "2026-07-06"])).toBe("Roti Jul 6 – 19");
  });

  it("shows the year only when the span crosses one", () => {
    expect(settlementLabel(["2025-12-29", "2026-01-05"])).toBe("Roti Dec 29, 2025 – Jan 11, 2026");
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Bhavin@Example.com  ")).toBe("bhavin@example.com");
  });
});

describe("missingSplitwiseLinks", () => {
  it("is empty when everyone with a share has an email", () => {
    const users = [user({ id: "u1", splitwise_email: "b@x.com" })];
    expect(missingSplitwiseLinks([total("u1", 5, 2.5)], users)).toEqual([]);
  });

  it("names whoever has a share but no saved email", () => {
    const users = [user({ id: "u1", name: "deven", splitwise_email: null })];
    expect(missingSplitwiseLinks([total("u1", 5, 2.5)], users)).toEqual(["Deven"]);
  });
});

describe("buildSplitwisePeople", () => {
  it("returns null when anyone with a share is unlinked", () => {
    const users = [user({ id: "u1", splitwise_email: null })];
    expect(buildSplitwisePeople([total("u1", 5, 2.5)], users)).toBeNull();
  });

  it("maps totals to the edge function's people shape when everyone is linked", () => {
    const users = [user({ id: "u1", name: "bhavin", splitwise_email: "b@x.com" })];
    expect(buildSplitwisePeople([total("u1", 5, 2.5)], users)).toEqual([
      { name: "bhavin", email: "b@x.com", qty: 5, amount: 2.5 },
    ]);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm run test -- splitwise.test.ts`
Expected: FAIL — `src/lib/splitwise.ts` does not exist yet.

- [ ] **Step 6: Implement `src/lib/splitwise.ts`**

```ts
import type { User } from "../types";
import type { PersonTotal } from "./aggregate";
import { cap, dateRangeLabel, parseYMD } from "./util";

// Pure helpers for the Splitwise push flow: building the expense description,
// mapping this app's per-person totals into the edge function's request
// shape, and spotting who isn't linked yet. No I/O, no React.

/** "Roti Jul 6 – 19" (or crossing months/years) across every week id given. */
export function settlementLabel(weekIds: string[]): string {
  const sorted = [...weekIds].sort();
  const first = parseYMD(sorted[0]);
  const last = parseYMD(sorted[sorted.length - 1]);
  last.setDate(last.getDate() + 6); // that week's Sunday
  const withYear = first.getFullYear() !== last.getFullYear();
  return `Roti ${dateRangeLabel(first, last, withYear)}`;
}

/** Canonical form for comparing Splitwise emails. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Display names of anyone holding a nonzero share with no saved Splitwise email. */
export function missingSplitwiseLinks(totals: PersonTotal[], users: User[]): string[] {
  return totals
    .filter((t) => !users.find((u) => u.id === t.userId)?.splitwise_email)
    .map((t) => cap(users.find((u) => u.id === t.userId)?.name ?? "unknown"));
}

/** One person's row in the push request the edge function expects. */
export interface SplitwisePerson {
  name: string;
  email: string;
  qty: number;
  amount: number;
}

/** Build the edge function's `people[]` payload, or null if anyone with a
 * share isn't linked — the caller should treat null as "block the push." */
export function buildSplitwisePeople(
  totals: PersonTotal[],
  users: User[],
): SplitwisePerson[] | null {
  if (missingSplitwiseLinks(totals, users).length > 0) return null;
  return totals.map((t) => {
    const user = users.find((u) => u.id === t.userId)!;
    return { name: user.name, email: user.splitwise_email!, qty: t.qty, amount: t.amount };
  });
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -- splitwise.test.ts util.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no new errors from these two files (existing `Week`/`User` literal errors from Task 2 elsewhere are still expected until later tasks fix them).

- [ ] **Step 9: Commit**

```bash
git add src/lib/util.ts src/lib/util.test.ts src/lib/splitwise.ts src/lib/splitwise.test.ts
git commit -m "feat: add Splitwise pure helpers (settlement label, share mapping, link check)"
```

---

## Task 4: Splitwise edge function

**Files:**
- Create: `supabase/functions/splitwise/index.ts`
- Create: `supabase/functions/splitwise/deno.json`
- Create: `supabase/functions/splitwise/.npmrc`

**Interfaces:**
- Consumes: `SPLITWISE_API_KEY`, `SPLITWISE_GROUP_ID` (Supabase secrets, already set on both projects).
- Produces: a POST endpoint at `<SUPABASE_URL>/functions/v1/splitwise` accepting `{action: "link", email}` / `{action: "push", payerEmail, people, totalCost, description, date}` / `{action: "delete", expense_id}`, requiring an authenticated Supabase session. This is the exact contract `src/lib/db.ts` (Task 6) calls via `supabase.functions.invoke("splitwise", {body: ...})`.

- [ ] **Step 1: Create `deno.json`**

```json
{
  "imports": {
    "@supabase/functions-js": "jsr:@supabase/functions-js@^2",
    "@supabase/server": "npm:@supabase/server@^1"
  }
}
```

- [ ] **Step 2: Create `.npmrc`** (mirrors `validate-access`'s, needed for the same private-registry reason)

```
# Configuration for private npm package dependencies
# For more information on using private registries with Edge Functions, see:
# https://supabase.com/docs/guides/functions/import-maps#importing-from-private-registries
```

- [ ] **Step 3: Implement `index.ts`**

```ts
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
  const members = await groupMembers(apiKey, groupId);
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

  const members = await groupMembers(apiKey, groupId);
  const byEmail = new Map(members.map((m) => [m.email, m.id]));

  const missing: string[] = [];
  const resolved = people.map((p) => {
    const id = byEmail.get(normalizeEmail(p.email));
    if (!id) missing.push(p.name);
    return { ...p, splitwiseId: id };
  });
  const payerId = byEmail.get(normalizeEmail(payerEmail));
  if (!payerId) missing.push("payer");
  if (missing.length > 0) {
    return Response.json({ ok: false, error: "not_linked", detail: missing.join(", ") });
  }

  const categoryId = await resolveCategoryId(apiKey, "Groceries");

  const params: Record<string, string> = {
    cost: totalCost.toFixed(2),
    group_id: groupId,
    description,
    date,
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
```

- [ ] **Step 4: Deploy to the test project**

Run: `supabase functions deploy splitwise --project-ref txsxfhfepwaxpujqxako --use-api --yes`
Expected: deploy succeeds.

- [ ] **Step 5: Manually verify the `link` action against the test group**

Get a session access token for a manual test call:

```bash
curl -s -X POST 'https://txsxfhfepwaxpujqxako.supabase.co/auth/v1/signup' \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" -H 'Content-Type: application/json' -d '{}' \
  | tee /tmp/anon.json | grep -o '"access_token":"[^"]*"'
```

Then, using that token and an email you know is (or isn't) a member of the test Splitwise group:

```bash
curl -s -X POST 'https://txsxfhfepwaxpujqxako.supabase.co/functions/v1/splitwise' \
  -H "Authorization: Bearer <access_token from above>" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"action":"link","email":"<a real member email of the test group>"}'
```

Expected: `{"linked":true,"splitwise_user_id":"..."}` for a real member, `{"linked":false}` for a made-up email. Also confirm a request with **no** `Authorization` header is rejected (401) rather than reaching the handler.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/splitwise/
git commit -m "feat: add Splitwise edge function (link/push/delete)"
```

---

## Task 5: db.ts — settlement write path

**Files:**
- Modify: `src/lib/db.ts`

**Interfaces:**
- Consumes: `Settlement`, `Week` from `src/types.ts` (Task 2).
- Produces: `createSettlement(weekIds: string[], actor: string, deviceId: string): Promise<void>`, `reopenWeek(week: Week, actor: string, deviceId: string): Promise<void>`. These replace `setPaid`/`settleAll` as the public write path for paying/reopening — later tasks (App.tsx, Task 11) call these exact names. `reopenWeek` throws a plain `Error` with a human-readable message when a Splitwise delete genuinely fails (as opposed to returning a result object), which callers are expected to catch.

- [ ] **Step 1: Replace `setPaid` and `settleAll` with `createSettlement`**

In `src/lib/db.ts`, remove the existing `setPaid` and `settleAll` functions:

```ts
export async function setPaid(
  weekId: string,
  paid: boolean,
  actor: string,
  deviceId: string,
): Promise<void> {
  await ensureWeek(weekId);
  const { error } = await supabase
    .from("weeks")
    .update({ paid, paid_at: paid ? new Date().toISOString() : null })
    .eq("week_start", weekId);
  if (error) fail("setPaid", error);
  await logAction({
    actor,
    action: paid ? "paid" : "reopen",
    week_start: weekId,
    device_id: deviceId,
  });
}

export async function settleAll(weekIds: string[], actor: string, deviceId: string): Promise<void> {
  for (const weekId of weekIds) {
    await setPaid(weekId, true, actor, deviceId);
  }
}
```

Replace them with:

```ts
/**
 * Pay one or more weeks in a single settlement — the pushable unit for the
 * Splitwise integration (§4.5/§7.2 of the design). A single-week Mark Paid
 * is `createSettlement([weekId], ...)`; Settle All passes every open week.
 */
export async function createSettlement(
  weekIds: string[],
  actor: string,
  deviceId: string,
): Promise<void> {
  for (const weekId of weekIds) {
    await ensureWeek(weekId);
  }

  const { data, error } = await supabase
    .from("settlements")
    .insert({ actor, device_id: deviceId })
    .select("id, created_at")
    .single();
  if (error) fail("createSettlement/insert", error);
  const { id: settlementId, created_at } = data as { id: string; created_at: string };

  const { error: upErr } = await supabase
    .from("weeks")
    .update({ paid: true, paid_at: created_at, settlement_id: settlementId })
    .in("week_start", weekIds);
  if (upErr) fail("createSettlement/weeks", upErr);

  for (const weekId of weekIds) {
    await logAction({ actor, action: "paid", week_start: weekId, device_id: deviceId });
  }
}
```

- [ ] **Step 2: Add `reopenWeek`**

Add after `createSettlement`:

```ts
/**
 * Reopen a week. If it belongs to a settlement, every week in that
 * settlement reopens together (§4.6) — a settlement is one payment event,
 * not divisible per week. A week paid before this feature shipped has no
 * settlement (`settlement_id` is null) and just reopens alone, exactly as
 * it always did.
 */
export async function reopenWeek(week: Week, actor: string, deviceId: string): Promise<void> {
  if (!week.settlement_id) {
    const { error } = await supabase
      .from("weeks")
      .update({ paid: false, paid_at: null })
      .eq("week_start", week.week_start);
    if (error) fail("reopenWeek", error);
    await logAction({ actor, action: "reopen", week_start: week.week_start, device_id: deviceId });
    return;
  }

  const { data: settlementRow, error: settlementErr } = await supabase
    .from("settlements")
    .select("splitwise_expense_id")
    .eq("id", week.settlement_id)
    .single();
  if (settlementErr) fail("reopenWeek/settlement", settlementErr);
  const expenseId = (settlementRow as { splitwise_expense_id: string | null }).splitwise_expense_id;

  if (expenseId) {
    const result = await deleteSplitwiseExpense(expenseId);
    if (!result.ok) {
      throw new Error(`Could not remove it from Splitwise (${result.error}). Nothing was reopened.`);
    }
  }

  const { data: weekRows, error: weeksErr } = await supabase
    .from("weeks")
    .select("week_start")
    .eq("settlement_id", week.settlement_id);
  if (weeksErr) fail("reopenWeek/lookup", weeksErr);
  const weekIds = (weekRows as { week_start: string }[]).map((w) => w.week_start);

  const { error: upErr } = await supabase
    .from("weeks")
    .update({ paid: false, paid_at: null, settlement_id: null })
    .in("week_start", weekIds);
  if (upErr) fail("reopenWeek/weeks", upErr);

  for (const weekId of weekIds) {
    if (expenseId) {
      await logAction({ actor, action: "splitwise_unpush", week_start: weekId, device_id: deviceId });
    }
    await logAction({ actor, action: "reopen", week_start: weekId, device_id: deviceId });
  }
}
```

Note: this references `deleteSplitwiseExpense`, added in Task 6. The file won't typecheck standalone until that task lands — that's fine, both tasks land together before the next `npm run typecheck` checkpoint in Task 6.

- [ ] **Step 3: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat: replace setPaid/settleAll with settlement-aware createSettlement/reopenWeek"
```

---

## Task 6: db.ts — Splitwise edge function calls + data loading

**Files:**
- Modify: `src/lib/db.ts`

**Interfaces:**
- Consumes: `reopenWeek`'s call to `deleteSplitwiseExpense` (Task 5); `Settlement`, `SplitwisePerson` (`src/lib/splitwise.ts`, Task 3).
- Produces: `checkSplitwiseLink(email: string): Promise<{linked: boolean; splitwiseUserId: string | null}>`, `setSplitwiseEmail(user: User, email: string, actor: string, deviceId: string): Promise<void>`, `deleteSplitwiseExpense(expenseId: string): Promise<{ok: boolean; error?: string}>`, `pushSettlement(settlementId: string, payer: User, people: SplitwisePerson[], totalCost: number, description: string, date: string, actor: string, deviceId: string, weekIds: string[]): Promise<PushResult>` where `PushResult = {ok: true; expenseId: string} | {ok: false; status?: "unknown"; error?: string}`. `loadActive()`'s return type gains `settlements: Settlement[]`. These are the exact names Task 7 (`useKhataData`), Task 8 (`PeopleSheet`), Task 9 (`WeekCard`), and Task 10/11 (`App.tsx`) call.

- [ ] **Step 1: Extend `loadActive` to fetch settlements**

In `src/lib/db.ts`, change:

```ts
export async function loadActive(): Promise<{
  weeks: Week[];
  entries: Entry[];
  users: User[];
  logs: LogRow[];
}> {
  // Independent queries — run them together.
  const [w, l, users] = await Promise.all([
    supabase.from("weeks").select("*"),
    supabase.from("logs").select("*").order("ts", { ascending: false }).limit(LOG_PAGE),
    loadUsers(),
  ]);
  if (w.error) fail("load weeks", w.error);
  if (l.error) fail("load logs", l.error);
  const weeks = (w.data ?? []) as Week[];

  // Entries depend on weeks result — fetch only for unpaid weeks.
  const unpaidIds = weeks.filter((wk) => !wk.paid).map((wk) => wk.week_start);
  let entries: Entry[] = [];
  if (unpaidIds.length > 0) {
    const e = await supabase.from("entries").select(SELECT_ENTRY).in("week_start", unpaidIds);
    if (e.error) fail("load entries", e.error);
    entries = (e.data ?? []) as Entry[];
  }

  return { weeks, entries, users, logs: (l.data ?? []) as LogRow[] };
}
```

to:

```ts
export async function loadActive(): Promise<{
  weeks: Week[];
  entries: Entry[];
  users: User[];
  logs: LogRow[];
  settlements: Settlement[];
}> {
  // Independent queries — run them together.
  const [w, l, users, s] = await Promise.all([
    supabase.from("weeks").select("*"),
    supabase.from("logs").select("*").order("ts", { ascending: false }).limit(LOG_PAGE),
    loadUsers(),
    supabase.from("settlements").select("*"),
  ]);
  if (w.error) fail("load weeks", w.error);
  if (l.error) fail("load logs", l.error);
  if (s.error) fail("load settlements", s.error);
  const weeks = (w.data ?? []) as Week[];

  // Entries depend on weeks result — fetch only for unpaid weeks.
  const unpaidIds = weeks.filter((wk) => !wk.paid).map((wk) => wk.week_start);
  let entries: Entry[] = [];
  if (unpaidIds.length > 0) {
    const e = await supabase.from("entries").select(SELECT_ENTRY).in("week_start", unpaidIds);
    if (e.error) fail("load entries", e.error);
    entries = (e.data ?? []) as Entry[];
  }

  return {
    weeks,
    entries,
    users,
    logs: (l.data ?? []) as LogRow[],
    settlements: (s.data ?? []) as Settlement[],
  };
}
```

Update the import line at the top of `db.ts` to include `Settlement`:

```ts
import type { Entry, LogAction, LogRow, Settlement, User, Week } from "../types";
```

- [ ] **Step 2: Add `subscribeChanges` coverage for `settlements`**

In `subscribeChanges`, add a fifth `.on(...)` call alongside the existing five:

```ts
export function subscribeChanges(onChange: () => void): () => void {
  const channel = supabase
    .channel("khata-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "weeks" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "entries" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "logs" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "entry_shares" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "users" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "settlements" }, onChange)
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
```

- [ ] **Step 3: Add the Splitwise-calling functions**

Add near the bottom of `db.ts`, before the `// ── realtime ──` section:

```ts
// ── Splitwise ──

/** Check a Splitwise email against the live group's members (§4.1/§9.1). */
export async function checkSplitwiseLink(
  email: string,
): Promise<{ linked: boolean; splitwiseUserId: string | null }> {
  const { data, error } = await supabase.functions.invoke("splitwise", {
    body: { action: "link", email },
  });
  if (error) fail("checkSplitwiseLink", error);
  const result = data as { linked: boolean; splitwise_user_id?: string };
  return { linked: result.linked, splitwiseUserId: result.splitwise_user_id ?? null };
}

/**
 * Save (or clear) a person's Splitwise email, re-checking it against the
 * live group every time (§4.2) — the stored `splitwise_user_id` is only a
 * People-sheet hint, never trusted at push time.
 */
export async function setSplitwiseEmail(user: User, email: string): Promise<void> {
  const clean = email.trim();
  const link = clean ? await checkSplitwiseLink(clean) : { linked: false, splitwiseUserId: null };
  const { error } = await supabase
    .from("users")
    .update({ splitwise_email: clean || null, splitwise_user_id: link.splitwiseUserId })
    .eq("id", user.id);
  if (error) fail("setSplitwiseEmail", error);
}

/** Delete a Splitwise expense. Treats "already gone" (per the edge
 * function) the same as a fresh success. */
export async function deleteSplitwiseExpense(
  expenseId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("splitwise", {
    body: { action: "delete", expense_id: expenseId },
  });
  if (error) return { ok: false, error: "network" };
  return data as { ok: boolean; error?: string };
}

export type PushResult =
  | { ok: true; expenseId: string }
  | { ok: false; status?: "unknown"; error?: string };

/**
 * Push a settlement to Splitwise. On an ambiguous outcome (network error,
 * dropped connection) the settlement is marked `splitwise_status: 'unknown'`
 * rather than silently retried (§4.9) — the caller is expected to require an
 * explicit re-confirmation before calling this again for the same settlement.
 */
export async function pushSettlement(
  settlementId: string,
  payer: User,
  people: SplitwisePerson[],
  totalCost: number,
  description: string,
  date: string,
  actor: string,
  deviceId: string,
  weekIds: string[],
): Promise<PushResult> {
  if (!payer.splitwise_email) {
    throw new Error("The chosen payer isn't linked to Splitwise.");
  }

  let invokeFailed = false;
  let data: { ok: boolean; expense_id?: string; error?: string } | undefined;
  try {
    const res = await supabase.functions.invoke("splitwise", {
      body: { action: "push", payerEmail: payer.splitwise_email, people, totalCost, description, date },
    });
    if (res.error) invokeFailed = true;
    else data = res.data as { ok: boolean; expense_id?: string; error?: string };
  } catch {
    invokeFailed = true;
  }

  if (invokeFailed || !data) {
    const { error } = await supabase
      .from("settlements")
      .update({ splitwise_status: "unknown" })
      .eq("id", settlementId);
    if (error) fail("pushSettlement/markUnknown", error);
    return { ok: false, status: "unknown" };
  }

  if (!data.ok || !data.expense_id) {
    return { ok: false, error: data.error ?? "unknown_error" };
  }

  const { error } = await supabase
    .from("settlements")
    .update({
      splitwise_expense_id: data.expense_id,
      splitwise_payer_user_id: payer.id,
      splitwise_pushed_at: new Date().toISOString(),
      splitwise_status: null,
    })
    .eq("id", settlementId);
  if (error) fail("pushSettlement/save", error);

  for (const weekId of weekIds) {
    await logAction({
      actor,
      action: "splitwise_push",
      week_start: weekId,
      detail: `${description} · ${money(totalCost)} · paid by ${cap(payer.name)}`,
      device_id: deviceId,
    });
  }

  return { ok: true, expenseId: data.expense_id };
}
```

Add one new import line, right after the existing `import type { ShareInput } from "./split";` line:

```ts
import type { SplitwisePerson } from "./splitwise";
```

Change the existing utils import line from `import { normalizeName } from "./util";` to:

```ts
import { cap, money, normalizeName } from "./util";
```

(Leave `import { supabase } from "./supabase";` and the `Entry, LogAction, LogRow, Settlement, User, Week` type import from Step 1 as they are — both already correct at this point.)

`setSplitwiseEmail` intentionally takes only `user` and `email` — linking isn't a logged action (§4.11 only requires logging push/unpush), so it needs no `actor`/`deviceId`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: `db.ts` itself is now internally consistent (no more errors about `deleteSplitwiseExpense`/`Settlement` being undefined). Errors remain in `App.tsx`/`useKhataData.ts`/component files still calling the old `setPaid`/`settleAll` or missing the new `Week`/`User`/`WeekView` fields — expected until Tasks 7–11 land.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat: add Splitwise link/push/delete calls to db.ts"
```

---

## Task 7: useKhataData.ts — load settlements, merge into WeekView

**Files:**
- Modify: `src/hooks/useKhataData.ts`

**Interfaces:**
- Consumes: `db.loadActive()`'s new `settlements` field (Task 6), `Settlement` type (Task 2).
- Produces: every `WeekView` returned by this hook now has `settlement: Settlement | null` populated. `App.tsx` (Tasks 10–11) reads `w.settlement` directly off the objects this hook returns.

- [ ] **Step 1: Track settlements and merge them into `weekViews`**

In `src/hooks/useKhataData.ts`, add a `Settlement` import:

```ts
import type { Entry, LogRow, Settlement, User, Week, WeekView } from "../types";
```

Add state alongside `logs`:

```ts
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
```

In `load()`, after `setLogs(data.logs);`, add:

```ts
      setSettlements(data.settlements);
```

In the `weekViews` `useMemo`, add a lookup map and use it when building each view. Change:

```ts
  const weekViews: WeekView[] = useMemo(() => {
    const byWeek = new Map<string, Entry[]>();
    for (const e of allEntries) {
      const arr = byWeek.get(e.week_start) ?? [];
      arr.push(e);
      byWeek.set(e.week_start, arr);
    }
    const paidMap = new Map(weeks.map((w) => [w.week_start, w]));
    const ids = new Set<string>([
      ...weeks.map((w) => w.week_start),
      ...allEntries.map((e) => e.week_start),
    ]);
    const views: WeekView[] = [];
    ids.forEach((id) => {
      const es = byWeek.get(id) ?? [];
      const wk = paidMap.get(id);
      views.push({
        week_start: id,
        paid: wk?.paid ?? false,
        paid_at: wk?.paid_at ?? null,
        entries: es,
        total: round2(es.reduce((s, e) => s + e.amount, 0)),
        count: es.reduce((s, e) => s + e.qty, 0),
      });
    });
    return views.sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
  }, [weeks, allEntries]);
```

to:

```ts
  const weekViews: WeekView[] = useMemo(() => {
    const byWeek = new Map<string, Entry[]>();
    for (const e of allEntries) {
      const arr = byWeek.get(e.week_start) ?? [];
      arr.push(e);
      byWeek.set(e.week_start, arr);
    }
    const paidMap = new Map(weeks.map((w) => [w.week_start, w]));
    const settlementsById = new Map(settlements.map((s) => [s.id, s]));
    const ids = new Set<string>([
      ...weeks.map((w) => w.week_start),
      ...allEntries.map((e) => e.week_start),
    ]);
    const views: WeekView[] = [];
    ids.forEach((id) => {
      const es = byWeek.get(id) ?? [];
      const wk = paidMap.get(id);
      views.push({
        week_start: id,
        paid: wk?.paid ?? false,
        paid_at: wk?.paid_at ?? null,
        settlement_id: wk?.settlement_id ?? null,
        settlement: wk?.settlement_id ? (settlementsById.get(wk.settlement_id) ?? null) : null,
        entries: es,
        total: round2(es.reduce((s, e) => s + e.amount, 0)),
        count: es.reduce((s, e) => s + e.qty, 0),
      });
    });
    return views.sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
  }, [weeks, allEntries, settlements]);
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no more errors from `useKhataData.ts` itself. Remaining errors should now only be in `App.tsx` and the component files touched in Tasks 8–11.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useKhataData.ts
git commit -m "feat: load settlements and merge push status into WeekView"
```

---

## Task 8: PeopleSheet.tsx — Splitwise email linking UI

**Files:**
- Modify: `src/components/PeopleSheet.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `db.setSplitwiseEmail` (Task 6), `User.splitwise_email`/`splitwise_user_id` (Task 2).
- Produces: no new exports — this is a leaf UI change.

- [ ] **Step 1: Add the per-row email input + linked indicator**

In `src/components/PeopleSheet.tsx`, add a new component above `PeopleSheet` itself:

```tsx
function EmailRow({
  user,
  disabled,
  onSave,
}: {
  user: User;
  disabled: boolean;
  onSave: (email: string) => void;
}) {
  const [value, setValue] = useState(user.splitwise_email ?? "");
  const linked = !!user.splitwise_user_id;
  return (
    <div className="ppl-splitwise">
      <input
        className="in ppl-email"
        placeholder="Splitwise email"
        value={value}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const clean = value.trim();
          if (clean !== (user.splitwise_email ?? "")) onSave(clean);
        }}
        aria-label={`${user.name}'s Splitwise email`}
      />
      {value && (
        <span className={"ppl-linked" + (linked ? " on" : "")}>{linked ? "Linked" : "Not linked"}</span>
      )}
    </div>
  );
}
```

Add a handler inside `PeopleSheet` (alongside `askDelete`/`handleAdd`), which rejects a duplicate email the same way `handleAdd` rejects a duplicate name:

```tsx
  async function handleEmailSave(target: User, email: string) {
    const clean = email.trim();
    if (clean) {
      const dupe = people.find(
        (p) => p.id !== target.id && p.splitwise_email?.toLowerCase() === clean.toLowerCase(),
      );
      if (dupe) {
        onError(`That email is already linked to ${cap(dupe.name)}.`);
        return;
      }
    }
    await run(() => db.setSplitwiseEmail(target, clean));
  }
```

Wire it into each row's markup — restructure the existing `<li key={u.id} className="ppl-row">` block. Change:

```tsx
              <li key={u.id} className="ppl-row">
                <span className="ppl-name">
                  {cap(u.name)}
                  {u.name === actor && <span className="ppl-you">you</span>}
                  {/* `title` never renders on a phone, and this is the sheet's
                      one safety-critical control — say why it is blocked. */}
                  {u.can_login && !mayRevoke && (
                    <span className="ppl-why">
                      {u.name === actor ? "can't remove your own access" : "last login"}
                    </span>
                  )}
                </span>

                <input
                  type="checkbox"
                  className="ppl-box"
                  checked={u.in_split}
                  disabled={locked}
                  onChange={(e) =>
                    run(() => db.setPersonFlag(u, "in_split", e.target.checked, actor, deviceId))
                  }
                  aria-label={`${u.name} in split`}
                />

                <input
                  type="checkbox"
                  className="ppl-box"
                  checked={u.can_login}
                  disabled={locked || (u.can_login && !mayRevoke)}
                  title={
                    u.can_login && !mayRevoke
                      ? u.name === actor
                        ? "You cannot revoke your own access"
                        : "Someone must be able to log in"
                      : undefined
                  }
                  onChange={(e) =>
                    run(() => db.setPersonFlag(u, "can_login", e.target.checked, actor, deviceId))
                  }
                  aria-label={`${u.name} can log in`}
                />

                <button
                  className="icon-btn"
                  disabled={locked || (u.can_login && !mayRevoke)}
                  onClick={() => askDelete(u)}
                  aria-label={`Delete ${u.name}`}
                >
                  <IcTrash className="ic sm" />
                </button>
              </li>
```

to:

```tsx
              <li key={u.id} className="ppl-row">
                <div className="ppl-row-main">
                  <span className="ppl-name">
                    {cap(u.name)}
                    {u.name === actor && <span className="ppl-you">you</span>}
                    {/* `title` never renders on a phone, and this is the sheet's
                        one safety-critical control — say why it is blocked. */}
                    {u.can_login && !mayRevoke && (
                      <span className="ppl-why">
                        {u.name === actor ? "can't remove your own access" : "last login"}
                      </span>
                    )}
                  </span>

                  <input
                    type="checkbox"
                    className="ppl-box"
                    checked={u.in_split}
                    disabled={locked}
                    onChange={(e) =>
                      run(() => db.setPersonFlag(u, "in_split", e.target.checked, actor, deviceId))
                    }
                    aria-label={`${u.name} in split`}
                  />

                  <input
                    type="checkbox"
                    className="ppl-box"
                    checked={u.can_login}
                    disabled={locked || (u.can_login && !mayRevoke)}
                    title={
                      u.can_login && !mayRevoke
                        ? u.name === actor
                          ? "You cannot revoke your own access"
                          : "Someone must be able to log in"
                        : undefined
                    }
                    onChange={(e) =>
                      run(() => db.setPersonFlag(u, "can_login", e.target.checked, actor, deviceId))
                    }
                    aria-label={`${u.name} can log in`}
                  />

                  <button
                    className="icon-btn"
                    disabled={locked || (u.can_login && !mayRevoke)}
                    onClick={() => askDelete(u)}
                    aria-label={`Delete ${u.name}`}
                  >
                    <IcTrash className="ic sm" />
                  </button>
                </div>
                <EmailRow
                  user={u}
                  disabled={locked}
                  onSave={(email) => handleEmailSave(u, email)}
                />
              </li>
```

- [ ] **Step 2: Update the CSS for the new row structure**

In `src/styles.css`, change:

```css
.ppl-row{ display:flex; align-items:center; gap:18px; padding:9px 0; border-top:1px dashed var(--line); min-height:44px; }
```

to:

```css
.ppl-row{ display:flex; flex-direction:column; gap:6px; padding:9px 0; border-top:1px dashed var(--line); }
.ppl-row-main{ display:flex; align-items:center; gap:18px; min-height:44px; }
.ppl-splitwise{ display:flex; align-items:center; gap:10px; }
.ppl-email{ flex:1; font-size:13px; padding:6px 8px; }
.ppl-linked{ font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--faint); white-space:nowrap; }
.ppl-linked.on{ color:var(--marigold); }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no more errors from `PeopleSheet.tsx`.

- [ ] **Step 4: Manually verify in the browser**

Run: `npm run dev`, open the app, sign in, open the People sheet.
Expected: each row shows a Splitwise email input under the name/checkboxes row. Typing an email and blurring saves it (check the Network tab for the `splitwise` function call) and shows "Linked"/"Not linked". Saving an email already used by another row shows the duplicate error via the toast instead of saving. Check this at a narrow (phone-width) viewport too, since this app is mobile-first — confirm the new row doesn't overflow or crowd the existing checkboxes/delete button.

- [ ] **Step 5: Commit**

```bash
git add src/components/PeopleSheet.tsx src/styles.css
git commit -m "feat: add Splitwise email linking to the People sheet"
```

---

## Task 9: WeekCard.tsx — push/pushed/reopen UI

**Files:**
- Modify: `src/components/WeekCard.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `missingSplitwiseLinks` (Task 3), `w.settlement` (Task 7).
- Produces: `WeekCard`'s `Props` gains `onPush: () => void`. `App.tsx` (Tasks 10–11) must pass this prop everywhere `WeekCard` is rendered.

- [ ] **Step 1: Add the `SplitwiseControl` sub-component**

In `src/components/WeekCard.tsx`, add near the top (after imports, before `CURRENT_YEAR`):

```tsx
function SplitwiseControl({
  settlement,
  missing,
  busy,
  onPush,
}: {
  settlement: Settlement | null;
  missing: string[];
  busy: boolean;
  onPush: () => void;
}) {
  if (!settlement) return null;
  if (settlement.splitwise_expense_id) {
    return (
      <a
        className="badge-pushed"
        href={`https://secure.splitwise.com/expenses/${settlement.splitwise_expense_id}`}
        target="_blank"
        rel="noreferrer"
      >
        <IcCheck className="ic sm" />
        Pushed
      </a>
    );
  }
  if (settlement.splitwise_status === "unknown") {
    return (
      <button className="link warn" disabled={busy} onClick={onPush}>
        Push status unknown — retry?
      </button>
    );
  }
  if (missing.length > 0) {
    return (
      <span className="link disabled" title={`${missing.join(", ")} not linked to Splitwise`}>
        {missing[0]} not linked
      </span>
    );
  }
  return (
    <button className="link" disabled={busy} onClick={onPush}>
      Push to Splitwise
    </button>
  );
}
```

Update the type import line to add `Settlement`:

```tsx
import type { Entry, Settlement, User, WeekView } from "../types";
```

Add `missingSplitwiseLinks` to the imports from `../lib/splitwise`:

```tsx
import { missingSplitwiseLinks } from "../lib/splitwise";
```

- [ ] **Step 2: Add the `onPush` prop and wire the footer**

Update `Props`:

```tsx
interface Props {
  w: WeekView;
  users: User[];
  busy: boolean;
  onEntry: (entry: Entry) => void;
  onDiscard: (entry: Entry) => void;
  onPay: () => void;
  onReopen: () => void;
  onPush: () => void;
}
```

Update the function signature:

```tsx
export function WeekCard({ w, users, busy, onEntry, onDiscard, onPay, onReopen, onPush }: Props) {
```

Inside the component body, after `const weekOther = otherQty(w.entries);`, add:

```tsx
  const missing = missingSplitwiseLinks(people, users);
```

(This reuses the `people` variable already computed a few lines above via `perPerson(w.entries)` — it's the same per-person totals the "Per person this week" section already renders. Note this only checks the current card's own week; a sibling week in the same multi-week settlement is checked separately by the App-level pre-check before the confirm dialog opens — see Task 10.)

Replace the paid footer:

```tsx
      {w.paid && (
        <div className="week-foot">
          <span className="locked-note">
            <IcLock className="ic sm" />
            Locked{w.paid_at ? ` · paid ${stamp(w.paid_at)}` : ""}
          </span>
          <button className="link" disabled={busy} onClick={onReopen}>
            Reopen
          </button>
        </div>
      )}
```

with:

```tsx
      {w.paid && (
        <div className="week-foot">
          <span className="locked-note">
            <IcLock className="ic sm" />
            Locked{w.paid_at ? ` · paid ${stamp(w.paid_at)}` : ""}
          </span>
          <div className="week-foot-a">
            <SplitwiseControl settlement={w.settlement} missing={missing} busy={busy} onPush={onPush} />
            <button className="link" disabled={busy} onClick={onReopen}>
              Reopen
            </button>
          </div>
        </div>
      )}
```

- [ ] **Step 3: Add supporting CSS**

In `src/styles.css`, find the existing `.week-foot`/`.locked-note` rules and add nearby:

```css
.week-foot-a{ display:flex; align-items:center; gap:14px; }
.badge-pushed{ display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:700; color:var(--marigold); text-decoration:none; }
.link.warn{ color:#b45309; }
.link.disabled{ color:var(--faint); cursor:default; }
```

(If `.week-foot`/`.locked-note` use different existing color variable names than `--marigold`/`--faint`, match whatever this file already uses for the "paid"/positive-state color — check the `.badge-paid` rule for the exact variable name in use and reuse it rather than introducing a new one.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: `WeekCard.tsx` itself no longer errors on its own props/types. `App.tsx` still errors because it doesn't pass `onPush` yet — fixed in Task 10.

- [ ] **Step 5: Commit**

```bash
git add src/components/WeekCard.tsx src/styles.css
git commit -m "feat: add push/pushed/reopen Splitwise controls to WeekCard"
```

---

## Task 10: PushSummary component + App.tsx push flow

**Files:**
- Create: `src/components/PushSummary.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `SettleSummary` (existing, unmodified), `settlementLabel`/`missingSplitwiseLinks`/`buildSplitwisePeople` (Task 3), `db.pushSettlement`/`db.createSettlement` (Tasks 5–6), `WeekCard`'s new `onPush` prop (Task 9).
- Produces: `PushSummary` component (props: `entries: Entry[]; users: User[]; weekIds: string[]; payerOptions: User[]; defaultPayerId: string | null; onPayerChange: (id: string | null) => void`). `App.tsx` gains `handlePush(w: WeekView)`, passed as `onPush` to every `WeekCard`.

- [ ] **Step 1: Create `PushSummary.tsx`**

```tsx
import { useState } from "react";
import type { Entry, User } from "../types";
import { SettleSummary } from "./SettleSummary";
import { cap } from "../lib/util";

interface Props {
  entries: Entry[];
  users: User[];
  weekIds: string[];
  payerOptions: User[];
  defaultPayerId: string | null;
  onPayerChange: (userId: string | null) => void;
}

/** The push confirm dialog's body: the same breakdown Mark Paid already
 * shows via SettleSummary, plus who's paying on Splitwise. */
export function PushSummary({
  entries,
  users,
  weekIds,
  payerOptions,
  defaultPayerId,
  onPayerChange,
}: Props) {
  const [payerId, setPayerId] = useState(defaultPayerId);
  return (
    <div className="push-summary">
      <SettleSummary entries={entries} users={users} weekIds={weekIds} />
      <label className="fld-l">Who paid?</label>
      <select
        className="in"
        value={payerId ?? ""}
        onChange={(e) => {
          const id = e.target.value || null;
          setPayerId(id);
          onPayerChange(id);
        }}
      >
        <option value="" disabled>
          Choose who paid
        </option>
        {payerOptions.map((u) => (
          <option key={u.id} value={u.id}>
            {cap(u.name)}
          </option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Add `handlePush` to `App.tsx`**

Add these imports to `App.tsx`:

```tsx
import { buildSplitwisePeople, missingSplitwiseLinks, settlementLabel } from "./lib/splitwise";
import { perPerson } from "./lib/aggregate";
import { PushSummary } from "./components/PushSummary";
```

`App.tsx` doesn't import from `./lib/aggregate` today, so this is a new import line. It also doesn't import `round2` today — change the existing line

```tsx
import { cap, dayLabel, money, normalizeName, todayStr, weekIdOf } from "./lib/util";
```

to:

```tsx
import { cap, dayLabel, money, normalizeName, round2, todayStr, weekIdOf } from "./lib/util";
```

Add a ref near the other `useRef`/`useState` declarations in `App.tsx`:

```tsx
  const pushPayerRef = useRef<string | null>(null);
```

Add `handlePush` alongside the other `handle*` functions (e.g. after `handleMarkPaid`):

```tsx
  function handlePush(w: WeekView) {
    if (!user || !w.settlement) return;
    const settlementId = w.settlement.id;
    const weekIds = shown
      .filter((x) => x.settlement?.id === settlementId)
      .map((x) => x.week_start);
    const settlementEntries = allEntries.filter((e) => weekIds.includes(e.week_start));
    const totals = perPerson(settlementEntries);
    const missing = missingSplitwiseLinks(totals, users);
    if (missing.length > 0) {
      flash(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} linked to Splitwise yet.`);
      return;
    }

    const people = buildSplitwisePeople(totals, users);
    if (!people) return; // unreachable given the check above; keeps TS satisfied

    const linkedPeople = users.filter((u) => u.splitwise_email);
    const defaultPayer = linkedPeople.find((u) => u.name === user) ?? null;
    pushPayerRef.current = defaultPayer?.id ?? null;

    const totalCost = round2(settlementEntries.reduce((sum, e) => sum + e.amount, 0));
    const description = settlementLabel(weekIds);
    const isRetry = w.settlement.splitwise_status === "unknown";

    setConfirm({
      title: isRetry ? "Retry pushing to Splitwise?" : "Push to Splitwise?",
      body: isRetry
        ? "The last attempt's outcome is unknown — it may already have been created. Check Splitwise before retrying to avoid a duplicate."
        : `Creating "${description}" for ${money(totalCost)}.`,
      detail: (
        <PushSummary
          entries={settlementEntries}
          users={users}
          weekIds={weekIds}
          payerOptions={linkedPeople}
          defaultPayerId={defaultPayer?.id ?? null}
          onPayerChange={(id) => {
            pushPayerRef.current = id;
          }}
        />
      ),
      cta: isRetry ? "Retry push" : "Push",
      tone: "go",
      onYes: () => {
        const payer = users.find((u) => u.id === pushPayerRef.current);
        withBusy(async () => {
          if (!payer) {
            flash("Choose who paid first.");
            return;
          }
          const result = await db.pushSettlement(
            settlementId,
            payer,
            people,
            totalCost,
            description,
            todayStr(),
            user,
            device,
            weekIds,
          );
          if (result.ok) flash("Pushed to Splitwise");
          else if (result.status === "unknown") flash("Could not confirm the push landed — check Splitwise.");
          else flash("Splitwise push failed. Try again.");
        });
      },
    });
  }
```

Pass `onPush={() => handlePush(w)}` to both places `WeekCard` is rendered directly in `App.tsx`'s unpaid list:

```tsx
                      <WeekCard
                        w={w}
                        users={users}
                        busy={busy}
                        onEntry={(entry) => setEditing(entry)}
                        onDiscard={(entry) => /* unchanged */}
                        onPay={() => /* unchanged */}
                        onPush={() => handlePush(w)}
                        onReopen={() => {}}
                      />
```

(The `<PaidHistory>` component also renders `WeekCard` internally — that's handled in Task 11, since `PaidHistory` needs its own `onPush` prop threaded through.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: remaining errors are only in `PaidHistory.tsx` (missing `onPush` prop) — fixed in Task 11.

- [ ] **Step 4: Commit**

```bash
git add src/components/PushSummary.tsx src/App.tsx
git commit -m "feat: wire the push-to-Splitwise confirm flow into App.tsx"
```

---

## Task 11: App.tsx reopen flow + PaidHistory wiring + Log display

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/PaidHistory.tsx`
- Modify: `src/components/LogView.tsx`

**Interfaces:**
- Consumes: `db.reopenWeek` (Task 5), `WeekCard`'s `onPush` prop (Task 9), `handlePush` (Task 10).
- Produces: no new exports — this finishes wiring the last two component boundaries and adds the two new log actions' display.

- [ ] **Step 1: Thread `onPush` through `PaidHistory`**

In `src/components/PaidHistory.tsx`, add `onPush` to `Props`:

```tsx
interface Props {
  paidCount: number;
  historyLoaded: boolean;
  loadingHistory: boolean;
  paid: WeekView[];
  users: User[];
  busy: boolean;
  onExpand: () => void;
  onReopen: (weekId: string) => void;
  onPush: (w: WeekView) => void;
}
```

Update the function signature and the inner `WeekCard`:

```tsx
export function PaidHistory({
  paidCount,
  historyLoaded,
  loadingHistory,
  paid,
  users,
  busy,
  onExpand,
  onReopen,
  onPush,
}: Props) {
```

```tsx
                  <WeekCard
                    w={w}
                    users={users}
                    busy={busy}
                    onEntry={() => {}}
                    onDiscard={() => {}}
                    onPay={() => {}}
                    onPush={() => onPush(w)}
                    onReopen={() => onReopen(w.week_start)}
                  />
```

- [ ] **Step 2: Replace `handleMarkPaid`'s reopen path and `handleSettleAll` in `App.tsx`**

Replace:

```tsx
  async function handleMarkPaid(weekId: string, paid: boolean) {
    if (!user) return;
    await withBusy(async () => {
      await db.setPaid(weekId, paid, user, device);
      flash(paid ? "Marked paid" : "Reopened");
    });
  }

  async function handleSettleAll() {
    if (!user) return;
    const ids = unpaid.map((w) => w.week_start);
    await withBusy(async () => {
      await db.settleAll(ids, user, device);
      flash("All weeks settled");
    });
  }
```

with:

```tsx
  async function handleMarkPaid(weekId: string) {
    if (!user) return;
    await withBusy(async () => {
      await db.createSettlement([weekId], user, device);
      flash("Marked paid");
    });
  }

  async function handleReopen(w: WeekView) {
    if (!user) return;
    await withBusy(async () => {
      try {
        await db.reopenWeek(w, user, device);
        flash("Reopened");
      } catch (e) {
        flash(e instanceof Error ? e.message : "Could not reopen.");
      }
    });
  }

  async function handleSettleAll() {
    if (!user) return;
    const ids = unpaid.map((w) => w.week_start);
    await withBusy(async () => {
      await db.createSettlement(ids, user, device);
      flash("All weeks settled");
    });
  }
```

Update the one call site that used the two-argument form — the unpaid `WeekCard`'s `onPay`:

```tsx
                        onPay={() =>
                          setConfirm({
                            title: "Mark this week paid?",
                            body: `Paying ${money(w.total)}. Here is what makes it up — entries lock once paid, and you can reopen later.`,
                            detail: (
                              <SettleSummary
                                entries={w.entries}
                                users={users}
                                weekIds={[w.week_start]}
                              />
                            ),
                            cta: "Mark paid",
                            tone: "go",
                            onYes: () => handleMarkPaid(w.week_start, true),
                          })
                        }
```

Change `onYes: () => handleMarkPaid(w.week_start, true)` to `onYes: () => handleMarkPaid(w.week_start)`.

- [ ] **Step 3: Replace the reopen confirm dialogs with settlement-aware copy**

Replace the unpaid-list `WeekCard`'s `onReopen={() => {}}` with a real handler that opens a confirm dialog. First add a helper function alongside `handlePush`:

```tsx
  function confirmReopen(w: WeekView) {
    const settlement = w.settlement;
    const siblingWeeks = settlement ? shown.filter((x) => x.settlement?.id === settlement.id) : [w];
    const pushed = !!settlement?.splitwise_expense_id;
    const parts = [
      siblingWeeks.length > 1
        ? `This will reopen all ${siblingWeeks.length} weeks settled together with it.`
        : "It will go back to unpaid so entries can be edited.",
    ];
    if (pushed) parts.push("It will also be removed from Splitwise first.");
    setConfirm({
      title: "Reopen this week?",
      body: parts.join(" "),
      cta: "Reopen",
      tone: "plain",
      onYes: () => handleReopen(w),
    });
  }
```

Change the unpaid `WeekCard`'s `onReopen={() => {}}` to `onReopen={() => confirmReopen(w)}` (a paid week never actually appears in the unpaid list, so this is defensive rather than reachable — matches the existing no-op it replaces).

Replace `PaidHistory`'s `onReopen` prop, currently:

```tsx
                  onReopen={(weekId) =>
                    setConfirm({
                      title: "Reopen this week?",
                      body: "It will go back to unpaid so entries can be edited. It re-joins your total.",
                      cta: "Reopen",
                      tone: "plain",
                      onYes: () => handleMarkPaid(weekId, false),
                    })
                  }
```

with:

```tsx
                  onReopen={(weekId) => {
                    const w = paid.find((x) => x.week_start === weekId);
                    if (w) confirmReopen(w);
                  }}
                  onPush={(w) => handlePush(w)}
```

- [ ] **Step 4: Add the two new log actions to `LogView.tsx`**

In `src/components/LogView.tsx`, add two cases to the `logText` switch, alongside the existing `"reopen"` case:

```tsx
    case "splitwise_push":
      return `pushed ${ev.week_start ? weekLabel(ev.week_start, true) : "a week"} to Splitwise`;
    case "splitwise_unpush":
      return `removed ${ev.week_start ? weekLabel(ev.week_start, true) : "a week"} from Splitwise`;
```

Add two entries to the `KIND` map:

```tsx
  splitwise_push: "c-paid",
  splitwise_unpush: "c-open",
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors anywhere in `src/`.

- [ ] **Step 6: Lint and format**

Run: `npm run lint && npm run format:check`
Expected: PASS. If `format:check` fails, run `npm run format` and re-check.

- [ ] **Step 7: Run the full test suite**

Run: `npm run test`
Expected: PASS — all existing tests plus the new ones from Task 3.

- [ ] **Step 8: Manually verify the full flow in the browser**

Run: `npm run dev`. With the test Splitwise group set up (Task 4) and at least one person linked (Task 8):
1. Add an entry, mark its week paid, open History, click "Push to Splitwise" — confirm the dialog shows the right breakdown and payer picker, confirm it, and check the expense actually appears in the test Splitwise group with the right description/date/currency/shares.
2. Click the resulting "Pushed" badge — confirm it opens the right expense on splitwise.com.
3. Click "Reopen" on that now-pushed week — confirm the expense disappears from the test group and the week becomes editable/unpaid again in the app.
4. Repeat with Settle All across two open weeks — confirm exactly one Splitwise expense gets created covering both.
5. Check the Log tab shows the push and the reopen-removal as separate entries.

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx src/components/PaidHistory.tsx src/components/LogView.tsx
git commit -m "feat: wire settlement-aware reopen and Splitwise log entries"
```

---

## Task 12: CI/deploy — deploy the function to production

**Files:**
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: nothing new — this only changes CI configuration.
- Produces: production deploys now also push the `splitwise` edge function.

- [ ] **Step 1: Add a deploy step**

In `.github/workflows/deploy.yml`, in the `supabase-deploy` job, add a step right after the existing `Deploy edge functions` step:

```yaml
      - name: Deploy edge functions
        # --use-api bundles server-side instead of via Docker — faster, and
        # removes a Docker dependency from CI. Idempotent redeploy either way.
        if: steps.check.outputs.ready == 'true'
        run: supabase functions deploy validate-access --use-api --yes
      - name: Deploy Splitwise function
        if: steps.check.outputs.ready == 'true'
        run: supabase functions deploy splitwise --use-api --yes
```

- [ ] **Step 2: Confirm production secrets are set**

Run (only if not already done earlier): `supabase secrets set --project-ref ruolemziparsvotdzbzw SPLITWISE_API_KEY=<rotated key> SPLITWISE_GROUP_ID=64748927`
Expected: confirms/sets the two secrets on the production project — required before the first real push in production, independent of this CI change.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: deploy the Splitwise edge function on merge to main"
```

---

## Self-Review Notes

**Spec coverage** — every numbered decision in the design doc maps to a task: linking (§4.1 → Task 8), freshness (§4.2 → Task 6/edge function), blocking on unlinked (§4.3 → Tasks 3, 9, 10), separate push button (§4.4 → Task 9/10), settlement batching (§4.5 → Task 1, 5), reopen semantics (§4.6 → Task 5, 11), payer (§4.7 → Task 10), expense shape (§4.8 → Task 3, 4, 10), failure/duplicate handling (§4.9 → Task 6), permissions (§4.10 → edge function auth in Task 4), audit log (§4.11 → Task 11).

**Type consistency verified** — `Settlement`, `SplitwisePerson`, `PushResult`, `WeekView.settlement`, and every function signature introduced in one task (`createSettlement`, `reopenWeek`, `pushSettlement`, `checkSplitwiseLink`, `setSplitwiseEmail`, `deleteSplitwiseExpense`, `settlementLabel`, `missingSplitwiseLinks`, `buildSplitwisePeople`, `dateRangeLabel`) are called with matching names/argument order in every later task that uses them.

**Known follow-up not in scope of this plan**: `canDeletePerson`/`hasShares` (in `src/lib/people.ts` and `PeopleSheet.tsx`) aren't updated to check settlement payership before offering deletion — the database's `on delete restrict` on `splitwise_payer_user_id` (Task 1) will correctly refuse the delete, but the People sheet's own pre-check won't explain why, surfacing the existing generic "Could not save that" message instead. Flagged in the design doc's risks section (§13) as an accepted, pre-existing class of trade-off rather than a new one.
