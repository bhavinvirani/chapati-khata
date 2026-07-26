# Per-Person Splits and User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split each purchase across named people, and move the login allowlist from a repo file into a database table any signed-in user can manage.

**Architecture:** `entries` becomes one row per _add_ (a purchase run with its own rate) instead of one row per day, with a child `entry_shares` table holding each person's qty and money. A new `users` table carries two independent switches — `in_split` and `can_login` — and replaces `allowed-names.json` as the login allowlist. All allocation, aggregation and guardrail logic lives as pure functions in `src/lib/`, which is also everything the tests cover; writes stay as plain `supabase-js` table calls in `src/lib/db.ts`.

**Tech Stack:** React 18 + TypeScript + Vite, Supabase (Postgres + PostgREST + Realtime + Edge Functions on Deno), vitest, GitHub Actions.

**Source spec:** [docs/superpowers/specs/2026-07-25-per-person-splits-and-user-management-design.md](../specs/2026-07-25-per-person-splits-and-user-management-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **Work on a feature branch, never on `main`.** A push to `main` runs `deploy.yml`, which applies pending migrations to the live database and deploys the site. Create the branch before Task 1: `git checkout -b feat/per-person-splits`.
- **Node `>=20.19.0`** (`package.json` `engines`; CI reads `.nvmrc`).
- **Migration filenames must match `^[0-9]{14}_[a-zA-Z0-9_]+\.sql$`.** Always create them with `npx supabase migration new <name>`; both `ci.yml` and `deploy.yml` fail the build otherwise.
- **No destructive SQL without an `-- allow-destructive` comment in the file.** The guard matches `drop table`, `drop column`, `drop schema`, `drop extension`, `truncate`, `delete from`, and `alter column ... type`. It does **not** match `alter table ... drop constraint`, so this plan needs no marker anywhere.
- **Conventional commits.** `deploy.yml` derives release tags from them: `feat:` → minor, `fix:` → patch, `docs:`/`chore:` → no tag.
- **Formatting and linting are CI gates.** Run `npm run format` before committing; `npm run lint` and `npm run typecheck` must pass.
- **Money:** amounts are `numeric(10,2)`, rates are `numeric(10,4)`. Always pass client-side money through `round2` from `src/lib/util.ts`.
- **Names** are stored lowercased and trimmed, matching how the gate already normalises input.
- **Tests run in `node` environment with `TZ=America/Toronto`** (`vitest.config.ts`). There is no jsdom and no testing-library — do not write component tests; components are verified by `npm run build` plus a manual pass.
- **Do not run the §13.1 data wipe or merge to `main`** as part of these tasks. Both are release steps, listed at the end.

---

## File Structure

**New — pure logic (all tested):**

| File                        | Responsibility                                                       |
| --------------------------- | -------------------------------------------------------------------- |
| `src/lib/split.ts`          | Allocation math: remainder, even split, share construction, rounding |
| `src/lib/split.test.ts`     | Tests for the above                                                  |
| `src/lib/people.ts`         | Guardrail predicates and people ordering/filtering                   |
| `src/lib/people.test.ts`    | Tests for the above                                                  |
| `src/lib/aggregate.ts`      | Per-person aggregation, day grouping, repair-state predicate         |
| `src/lib/aggregate.test.ts` | Tests for the above                                                  |

**New — UI:**

| File                             | Responsibility                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/components/SplitEditor.tsx` | The per-person allocation widget. Shared by AddForm and EditSheet. Controlled — owns no persistence. |
| `src/components/PeopleSheet.tsx` | People management sheet                                                                              |

**New — database:**

| File                                            | Responsibility    |
| ----------------------------------------------- | ----------------- |
| `supabase/migrations/<ts>_splits_and_users.sql` | The one migration |

**Modified:**

`src/types.ts`, `src/config.ts`, `src/lib/db.ts`, `src/hooks/useAuth.ts`, `src/hooks/useKhataData.ts`, `src/components/AddForm.tsx`, `src/components/EditSheet.tsx`, `src/components/WeekCard.tsx`, `src/components/StatsSheet.tsx`, `src/components/LogView.tsx`, `src/components/Header.tsx`, `src/components/icons.tsx`, `src/App.tsx`, `src/styles.css`, `supabase/schema.sql`, `supabase/functions/validate-access/index.ts`, `supabase/functions/validate-access/deno.json`, `.github/workflows/deploy.yml`

**Deleted:** `allowed-names.json`

---

## Task 1: Types and allocation math

The pure core of the feature. Types are added first because every later task
references them; all additions here are additive, so the existing code keeps
compiling untouched.

**Files:**

- Modify: `src/types.ts`
- Create: `src/lib/split.ts`
- Test: `src/lib/split.test.ts`

**Interfaces:**

- Consumes: `round2` from `src/lib/util.ts`
- Produces: types `User`, `EntryShare`, `ShareInput`, `Alloc`; functions `allocated`, `remaining`, `evenSplit`, `buildShares`, `sharesAmount`

- [ ] **Step 1: Add the new types**

Replace the whole of `src/types.ts` with:

```ts
// Row shapes mirror the Postgres tables in supabase/schema.sql.

export interface Week {
  week_start: string; // 'YYYY-MM-DD' (Monday) — primary key
  paid: boolean;
  paid_at: string | null; // ISO timestamp
}

export interface User {
  id: string; // uuid
  name: string; // lowercase, unique
  in_split: boolean; // appears in the split composer
  can_login: boolean; // passes the gate
  created_at: string; // ISO timestamp — also the composer's row order
}

export interface EntryShare {
  entry_id: string; // uuid -> entries.id
  user_id: string; // uuid -> users.id
  qty: number;
  amount: number;
}

export interface Entry {
  id: string; // uuid
  week_start: string; // FK -> weeks.week_start
  day: string; // 'YYYY-MM-DD' — NOT unique; one row per add
  qty: number; // the add's total — always equals the sum of its shares
  rate: number; // price per chapati for this add
  amount: number; // always equals the sum of its shares' amounts
  note: string;
  created_at: string; // ISO timestamp — orders adds within a day
  entry_shares: EntryShare[]; // embedded by PostgREST; [] means "needs repair"
}

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
  | "user_login_off";

export interface LogRow {
  id: string;
  ts: string; // ISO timestamp
  actor: string; // the name typed at the gate
  action: LogAction;
  week_start: string | null;
  day: string | null;
  qty_before: number | null;
  qty_after: number | null;
  note_before: string | null;
  note_after: string | null;
  target: string | null; // the person a user_* action refers to
  device_id: string | null; // breadcrumb — not shown in the UI
}

// A week with its entries attached, ready to render.
export interface WeekView extends Week {
  entries: Entry[];
  total: number;
  count: number;
}

export interface Confirm {
  title: string;
  body: string;
  cta: string;
  tone: "go" | "plain";
  onYes: () => void;
}
```

- [ ] **Step 2: Verify existing code still compiles**

Run: `npm run typecheck`
Expected: PASS. The additions are additive; `db.ts` casts query results with
`as Entry[]` rather than constructing them, so new required fields break nothing.

- [ ] **Step 3: Write the failing tests**

Create `src/lib/split.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { allocated, buildShares, evenSplit, remaining, sharesAmount } from "./split";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";

describe("allocated", () => {
  it("sums the rows", () => {
    expect(allocated({ [A]: 7, [B]: 5 })).toBe(12);
  });

  it("is zero for an empty allocation", () => {
    expect(allocated({})).toBe(0);
  });

  it("ignores blank rows", () => {
    expect(allocated({ [A]: 7, [B]: 0 })).toBe(7);
  });
});

describe("remaining", () => {
  it("is positive when under-allocated", () => {
    expect(remaining(45, { [A]: 20 })).toBe(25);
  });

  it("is zero when exact", () => {
    expect(remaining(12, { [A]: 7, [B]: 5 })).toBe(0);
  });

  it("is negative when over-allocated", () => {
    expect(remaining(10, { [A]: 7, [B]: 5 })).toBe(-2);
  });
});

describe("evenSplit", () => {
  it("divides exactly when it divides exactly", () => {
    expect(evenSplit(21, [A, B, C])).toEqual({ [A]: 7, [B]: 7, [C]: 7 });
  });

  it("gives the remainder to the first people in order", () => {
    expect(evenSplit(23, [A, B, C])).toEqual({ [A]: 8, [B]: 8, [C]: 7 });
  });

  it("still sums to the total when the remainder is spread", () => {
    const split = evenSplit(45, [A, B, C]);
    expect(allocated(split)).toBe(45);
  });

  it("handles a single person", () => {
    expect(evenSplit(9, [A])).toEqual({ [A]: 9 });
  });

  it("returns nothing when there is nobody to split across", () => {
    expect(evenSplit(9, [])).toEqual({});
  });

  it("gives everything to the first people when there are more people than chapatis", () => {
    expect(evenSplit(2, [A, B, C])).toEqual({ [A]: 1, [B]: 1, [C]: 0 });
  });
});

describe("buildShares", () => {
  it("prices each share at the add's rate", () => {
    expect(buildShares({ [A]: 7, [B]: 5 }, 0.5)).toEqual([
      { user_id: A, qty: 7, amount: 3.5 },
      { user_id: B, qty: 5, amount: 2.5 },
    ]);
  });

  it("omits people who took nothing rather than storing a zero", () => {
    expect(buildShares({ [A]: 7, [B]: 0 }, 0.5)).toEqual([{ user_id: A, qty: 7, amount: 3.5 }]);
  });

  it("rounds each share to the cent", () => {
    expect(buildShares({ [A]: 3 }, 0.125)).toEqual([{ user_id: A, qty: 3, amount: 0.38 }]);
  });
});

describe("sharesAmount", () => {
  it("sums the share amounts", () => {
    expect(sharesAmount(buildShares({ [A]: 7, [B]: 5 }, 0.5))).toBe(6);
  });

  // The invariant that makes per-person figures reconcile: the add's amount is
  // the sum of its (already rounded) shares, NOT round2(total * rate). At an
  // awkward rate those differ, and the discrepancy belongs on the group total.
  it("can differ from pricing the total in one go, and that is intended", () => {
    const shares = buildShares({ [A]: 1, [B]: 1, [C]: 1 }, 0.125);
    expect(sharesAmount(shares)).toBe(0.39);
    expect(sharesAmount(shares)).not.toBe(0.38); // round2(3 * 0.125)
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/lib/split.test.ts`
Expected: FAIL — `Failed to resolve import "./split"`.

- [ ] **Step 5: Write the implementation**

Create `src/lib/split.ts`:

```ts
import { round2 } from "./util";

// Pure allocation math for splitting one add across people. No I/O, no React —
// this is the whole of the arithmetic the entry flow depends on.

/** A work-in-progress allocation: user id -> chapatis. Blank rows may be 0. */
export type Alloc = Record<string, number>;

/** One person's share, shaped for insertion into entry_shares. */
export interface ShareInput {
  user_id: string;
  qty: number;
  amount: number;
}

/** Total chapatis handed out so far. */
export function allocated(rows: Alloc): number {
  return Object.values(rows).reduce((sum, qty) => sum + (qty || 0), 0);
}

/** Positive means chapatis are still unassigned; negative means over-allocated. */
export function remaining(total: number, rows: Alloc): number {
  return total - allocated(rows);
}

/**
 * Split `total` across `userIds`: everyone gets floor(total / n), and the
 * remainder is handed out one extra each to the first `r` people in order.
 * Deterministic, so the result is directly testable.
 */
export function evenSplit(total: number, userIds: string[]): Alloc {
  const out: Alloc = {};
  if (userIds.length === 0) return out;
  const base = Math.floor(total / userIds.length);
  const extra = total % userIds.length;
  userIds.forEach((id, i) => {
    out[id] = base + (i < extra ? 1 : 0);
  });
  return out;
}

/**
 * Turn an allocation into rows to persist. People who took nothing get no row
 * at all — "who was in this add" is exactly the set of rows present.
 */
export function buildShares(rows: Alloc, rate: number): ShareInput[] {
  return Object.entries(rows)
    .filter(([, qty]) => qty > 0)
    .map(([user_id, qty]) => ({ user_id, qty, amount: round2(qty * rate) }));
}

/**
 * The add's stored amount. Deliberately the sum of the already-rounded shares
 * rather than round2(total * rate): at an awkward rate the two differ by a
 * cent, and that discrepancy belongs on the group total, not on the split.
 */
export function sharesAmount(shares: ShareInput[]): number {
  return round2(shares.reduce((sum, s) => sum + s.amount, 0));
}
```

Note the file imports only `round2` — it knows nothing about `User`. Choosing
_who_ to offer is a people question and lives in `people.ts` (Task 2); this file
is only the arithmetic.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/split.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 7: Format, lint, typecheck**

Run: `npm run format && npm run lint && npm run typecheck`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/lib/split.ts src/lib/split.test.ts
git commit -m "feat: add allocation math and per-person types"
```

---

## Task 2: People guardrails

Two predicates that keep the group from locking itself out, plus the
share-existence question that decides whether a person can be deleted outright.

**Files:**

- Create: `src/lib/people.ts`
- Test: `src/lib/people.test.ts`

**Interfaces:**

- Consumes: `User` from `src/types.ts`
- Produces: `canRevokeLogin(target, actorName, users)`, `canDelete(hasShares)`, `sortPeople(users)`, `splitMembers(users)`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/people.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { User } from "../types";
import { canDelete, canRevokeLogin, sortPeople, splitMembers } from "./people";

function user(name: string, over: Partial<User> = {}): User {
  return {
    id: `id-${name}`,
    name,
    in_split: true,
    can_login: true,
    created_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

describe("canRevokeLogin", () => {
  it("allows revoking someone else when others can still log in", () => {
    const users = [user("bhavin"), user("deven"), user("parth")];
    expect(canRevokeLogin(users[1], "bhavin", users)).toBe(true);
  });

  it("refuses to let you revoke your own access", () => {
    const users = [user("bhavin"), user("deven")];
    expect(canRevokeLogin(users[0], "bhavin", users)).toBe(false);
  });

  it("refuses to revoke the last person who can log in", () => {
    const users = [user("bhavin"), user("deven", { can_login: false })];
    expect(canRevokeLogin(users[0], "deven", users)).toBe(false);
  });

  it("ignores people who already cannot log in when counting", () => {
    const users = [
      user("bhavin"),
      user("deven"),
      user("parth", { can_login: false }),
      user("samir", { can_login: false }),
    ];
    expect(canRevokeLogin(users[0], "deven", users)).toBe(true);
  });
});

describe("canDelete", () => {
  it("allows deleting a person who holds no shares", () => {
    expect(canDelete(false)).toBe(true);
  });

  it("refuses to delete a person who appears in history", () => {
    expect(canDelete(true)).toBe(false);
  });
});

describe("sortPeople", () => {
  it("orders by when they were added, so new people append at the bottom", () => {
    const users = [
      user("parth", { created_at: "2026-07-03T00:00:00Z" }),
      user("bhavin", { created_at: "2026-07-01T00:00:00Z" }),
      user("deven", { created_at: "2026-07-02T00:00:00Z" }),
    ];
    expect(sortPeople(users).map((u) => u.name)).toEqual(["bhavin", "deven", "parth"]);
  });

  it("does not mutate its input", () => {
    const users = [
      user("parth", { created_at: "2026-07-03T00:00:00Z" }),
      user("bhavin", { created_at: "2026-07-01T00:00:00Z" }),
    ];
    sortPeople(users);
    expect(users[0].name).toBe("parth");
  });

  // The seed inserts everyone in one statement, so every seeded person shares
  // a created_at. This is the normal case for the first seven people, not an
  // edge case, and without a tiebreak their order would be unspecified.
  it("falls back to name when timestamps tie, as the seeded people do", () => {
    const users = [user("samir"), user("abhishek"), user("deven")];
    expect(sortPeople(users).map((u) => u.name)).toEqual(["abhishek", "deven", "samir"]);
  });
});

describe("splitMembers", () => {
  it("offers only people whose split switch is on", () => {
    const users = [user("bhavin"), user("deven", { in_split: false }), user("parth")];
    expect(splitMembers(users).map((u) => u.name)).toEqual(["bhavin", "parth"]);
  });

  it("keeps someone who cannot log in but still eats", () => {
    const users = [user("bhavin"), user("samir", { can_login: false })];
    expect(splitMembers(users).map((u) => u.name)).toEqual(["bhavin", "samir"]);
  });

  it("returns them in row order", () => {
    const users = [
      user("parth", { created_at: "2026-07-03T00:00:00Z" }),
      user("bhavin", { created_at: "2026-07-01T00:00:00Z" }),
    ];
    expect(splitMembers(users).map((u) => u.name)).toEqual(["bhavin", "parth"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/people.test.ts`
Expected: FAIL — `Failed to resolve import "./people"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/people.ts`:

```ts
import type { User } from "../types";

// Guardrails for people management. There is no admin role — anyone signed in
// can change anyone — so these are what stop the group locking itself out.

/**
 * May `actorName` clear `target`'s login switch?
 *
 * No if it is the actor themselves — revoking your own access mid-session is
 * never what you meant. No if the target is the last person who can log in,
 * which would leave recovery to the Supabase SQL editor.
 */
export function canRevokeLogin(target: User, actorName: string, users: User[]): boolean {
  if (target.name === actorName) return false;
  const withLogin = users.filter((u) => u.can_login);
  if (withLogin.length <= 1) return false;
  return true;
}

/**
 * May this person be deleted outright? Only when they hold no shares, so a
 * mistyped name can be cleaned up but real history can never be orphaned.
 * The database enforces this independently via `on delete restrict`; this
 * check exists to produce a sentence instead of a foreign-key error.
 */
export function canDelete(hasShares: boolean): boolean {
  return !hasShares;
}

/**
 * People in stable display order: oldest first, so additions append.
 *
 * Name breaks ties, and ties are the normal case rather than an edge one: the
 * seed inserts everyone in a single statement and Postgres `now()` is
 * transaction-stable, so every seeded person shares one `created_at`. A
 * comparator that never returns 0 would leave their row order resting on
 * unspecified sort behaviour, and rows that reshuffle between loads are how
 * you type a count into the wrong person's box.
 */
export function sortPeople(users: User[]): User[] {
  return [...users].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name),
  );
}

/**
 * The people the split composer offers, in row order.
 *
 * Only the split switch matters here — someone who eats but never opens the
 * app still belongs in the split, and someone on a break does not.
 */
export function splitMembers(users: User[]): User[] {
  return sortPeople(users.filter((u) => u.in_split));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/people.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Format, lint, typecheck, then commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/lib/people.ts src/lib/people.test.ts
git commit -m "feat: add people management guardrails"
```

---

## Task 3: Aggregation and the repair predicate

Everything the display layer needs to turn rows into per-person figures, plus
the check that spots a half-written add.

**Files:**

- Create: `src/lib/aggregate.ts`
- Test: `src/lib/aggregate.test.ts`

**Interfaces:**

- Consumes: `Entry`, `User` from `src/types.ts`; `round2` from `src/lib/util.ts`
- Produces: `PersonTotal`, `perPerson(entries)`, `groupByDay(entries)`, `needsRepair(entry)`, `nameOf(users, userId)`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/aggregate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Entry, EntryShare } from "../types";
import { groupByDay, nameOf, needsRepair, perPerson } from "./aggregate";

const A = "user-a";
const B = "user-b";

function share(user_id: string, qty: number, amount: number): EntryShare {
  return { entry_id: "e1", user_id, qty, amount };
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    week_start: "2026-07-20",
    day: "2026-07-22",
    qty: 12,
    rate: 0.5,
    amount: 6,
    note: "",
    created_at: "2026-07-22T09:00:00Z",
    entry_shares: [share(A, 7, 3.5), share(B, 5, 2.5)],
    ...over,
  };
}

describe("perPerson", () => {
  it("totals one add", () => {
    expect(perPerson([entry()])).toEqual([
      { userId: A, qty: 7, amount: 3.5 },
      { userId: B, qty: 5, amount: 2.5 },
    ]);
  });

  it("accumulates the same person across several adds", () => {
    const morning = entry({ id: "e1", entry_shares: [share(A, 7, 3.5)] });
    const evening = entry({ id: "e2", rate: 0.75, entry_shares: [share(A, 10, 7.5)] });
    expect(perPerson([morning, evening])).toEqual([{ userId: A, qty: 17, amount: 11 }]);
  });

  it("keeps money exact across two runs at different rates", () => {
    // The reason rate is per-add: at a blended rate this comes out $9.81.
    const morning = entry({ id: "e1", rate: 0.5, entry_shares: [share(A, 7, 3.5)] });
    const evening = entry({ id: "e2", rate: 0.75, entry_shares: [share(A, 10, 7.5)] });
    expect(perPerson([morning, evening])[0].amount).toBe(11);
  });

  it("sorts by spend, biggest first", () => {
    const rows = perPerson([entry()]);
    expect(rows[0].userId).toBe(A);
  });

  it("is empty when nothing is split", () => {
    expect(perPerson([entry({ entry_shares: [] })])).toEqual([]);
  });
});

describe("groupByDay", () => {
  it("puts several adds under one day, newest day first", () => {
    const wed = entry({ id: "e1", day: "2026-07-22" });
    const wedAgain = entry({ id: "e2", day: "2026-07-22" });
    const thu = entry({ id: "e3", day: "2026-07-23" });
    const days = groupByDay([wed, wedAgain, thu]);
    expect(days.map((d) => d.day)).toEqual(["2026-07-23", "2026-07-22"]);
    expect(days[1].adds).toHaveLength(2);
  });

  it("totals each day across its adds", () => {
    const morning = entry({ id: "e1", day: "2026-07-22", qty: 45, amount: 22.5 });
    const evening = entry({ id: "e2", day: "2026-07-22", qty: 20, amount: 15 });
    const [wed] = groupByDay([morning, evening]);
    expect(wed.qty).toBe(65);
    expect(wed.amount).toBe(37.5);
  });
});

describe("needsRepair", () => {
  it("passes a well-formed add", () => {
    expect(needsRepair(entry())).toBe(false);
  });

  it("flags an add whose shares never landed", () => {
    expect(needsRepair(entry({ entry_shares: [] }))).toBe(true);
  });

  it("flags an add whose shares do not sum to its total", () => {
    expect(needsRepair(entry({ qty: 20 }))).toBe(true);
  });
});

describe("nameOf", () => {
  const users = [
    { id: A, name: "bhavin", in_split: true, can_login: true, created_at: "2026-07-01T00:00:00Z" },
  ];

  it("resolves a known id", () => {
    expect(nameOf(users, A)).toBe("bhavin");
  });

  it("falls back rather than rendering a raw uuid", () => {
    expect(nameOf(users, "ghost")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/aggregate.test.ts`
Expected: FAIL — `Failed to resolve import "./aggregate"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/aggregate.ts`:

```ts
import type { Entry, User } from "../types";
import { round2 } from "./util";

// Turning stored rows into the figures the UI shows. Pure — the display layer
// does no arithmetic of its own.

export interface PersonTotal {
  userId: string;
  qty: number;
  amount: number;
}

/** One calendar day and the adds recorded against it. */
export interface DayGroup {
  day: string;
  adds: Entry[];
  qty: number;
  amount: number;
}

/**
 * Per-person totals across any set of adds, biggest spender first.
 *
 * Money accumulates from the stored share amounts rather than being recomputed
 * from a rate, which is what keeps two runs at different rates exact.
 */
export function perPerson(entries: Entry[]): PersonTotal[] {
  const byUser = new Map<string, PersonTotal>();
  for (const e of entries) {
    for (const s of e.entry_shares ?? []) {
      const row = byUser.get(s.user_id) ?? { userId: s.user_id, qty: 0, amount: 0 };
      row.qty += s.qty;
      row.amount = round2(row.amount + s.amount);
      byUser.set(s.user_id, row);
    }
  }
  return [...byUser.values()].sort((a, b) => b.amount - a.amount);
}

/** Adds grouped under their day, newest day first. */
export function groupByDay(entries: Entry[]): DayGroup[] {
  const byDay = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = byDay.get(e.day) ?? [];
    arr.push(e);
    byDay.set(e.day, arr);
  }
  return [...byDay.entries()]
    .map(([day, adds]) => ({
      day,
      adds,
      qty: adds.reduce((sum, a) => sum + a.qty, 0),
      amount: round2(adds.reduce((sum, a) => sum + a.amount, 0)),
    }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

/**
 * True when an add's shares are missing or do not add up to its total.
 *
 * Writes are not transactional (see the spec's §7), so a dropped connection
 * can leave an add without its shares. This is how the UI notices.
 */
export function needsRepair(entry: Entry): boolean {
  const shares = entry.entry_shares ?? [];
  if (shares.length === 0) return true;
  return shares.reduce((sum, s) => sum + s.qty, 0) !== entry.qty;
}

/** A person's name for display, never a raw uuid. */
export function nameOf(users: User[], userId: string): string {
  return users.find((u) => u.id === userId)?.name ?? "unknown";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/aggregate.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm run test`
Expected: PASS, 41 tests across three files.

- [ ] **Step 6: Format, lint, typecheck, then commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/lib/aggregate.ts src/lib/aggregate.test.ts
git commit -m "feat: add per-person aggregation and repair detection"
```

---

## Task 4: Database migration

**Files:**

- Create: `supabase/migrations/<timestamp>_splits_and_users.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**

- Produces: tables `users`, `entry_shares`; columns `entries.rate`, `logs.target`

- [ ] **Step 1: Create the migration file with the correct name**

Run: `npx supabase migration new splits_and_users`

This generates `supabase/migrations/<14-digit-timestamp>_splits_and_users.sql`.
Do not hand-name the file — both CI workflows reject anything that does not
match `^[0-9]{14}_[a-zA-Z0-9_]+\.sql$`.

- [ ] **Step 2: Write the migration**

Put this in the generated file:

```sql
-- Per-person splits and DB-backed user management.
--
-- entries goes from one row per day to one row per ADD, each carrying its own
-- rate, with a child entry_shares table holding the per-person breakdown.
-- users replaces allowed-names.json as the login allowlist.

-- ── people ──
create table if not exists public.users (
  id         uuid    primary key default gen_random_uuid(),
  name       text    not null unique,        -- lowercase, trimmed
  in_split   boolean not null default true,  -- offered in the split composer
  can_login  boolean not null default true,  -- passes the gate
  created_at timestamptz not null default now()
);

-- Seed from the allowed-names.json list this migration retires. Written
-- literally because SQL cannot read a repo file, and the file is deleted in
-- this same change.
insert into public.users (name)
values ('bhavin'), ('abhishek'), ('deven'), ('parth'), ('pratik'), ('hitanshi'), ('samir')
on conflict (name) do nothing;

-- ── one row per add, not per day ──
alter table public.entries add column if not exists rate numeric(10,4);
update public.entries set rate = case when qty > 0 then amount / qty else 0.5 end where rate is null;
alter table public.entries alter column rate set not null;
alter table public.entries add constraint entries_rate_check check (rate > 0);

-- Several adds may now share a date. Not matched by the CI destructive-SQL
-- guard, which looks for drop table/column/schema/extension — not constraints.
alter table public.entries drop constraint if exists entries_day_key;
create index if not exists entries_day_idx on public.entries(day);

-- ── the per-person breakdown ──
-- on delete restrict is the teeth behind "a person with history cannot be
-- deleted"; on delete cascade means removing an add takes its shares with it.
create table if not exists public.entry_shares (
  entry_id uuid    not null references public.entries(id) on delete cascade,
  user_id  uuid    not null references public.users(id)   on delete restrict,
  qty      integer not null check (qty > 0),
  amount   numeric(10,2) not null,
  primary key (entry_id, user_id)
);
create index if not exists entry_shares_user_idx on public.entry_shares(user_id);

-- ── the person a user_* log action refers to ──
alter table public.logs add column if not exists target text;

-- ── same light gate as the other tables ──
alter table public.users        enable row level security;
alter table public.entry_shares enable row level security;

drop policy if exists "authed all - users"         on public.users;
drop policy if exists "authed all - entry_shares"  on public.entry_shares;

create policy "authed all - users"        on public.users        for all to authenticated using (true) with check (true);
create policy "authed all - entry_shares" on public.entry_shares for all to authenticated using (true) with check (true);

-- RLS only takes effect once the role also holds the table-level grant;
-- without this, queries fail with "permission denied for table ...".
grant select, insert, update, delete on public.users, public.entry_shares to authenticated;

-- ── realtime ──
-- Guarded because `alter publication ... add table` has no `if not exists`
-- form and errors on a second run.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'users'
  ) then
    alter publication supabase_realtime add table public.users;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'entry_shares'
  ) then
    alter publication supabase_realtime add table public.entry_shares;
  end if;
end $$;
```

Note the `update ... set rate` backfill: the release wipes the data first, so it
should touch nothing, but it lets the migration apply cleanly against a database
that still has rows — which is what you want if the wipe is ever skipped or the
migration is replayed against a copy.

- [ ] **Step 3: Verify the CI migration guard accepts it**

Run the exact check from `ci.yml` locally:

```bash
shopt -s nullglob
fail=0
for f in supabase/migrations/*.sql; do
  base=$(basename "$f")
  if ! [[ "$base" =~ ^[0-9]{14}_[a-zA-Z0-9_]+\.sql$ ]]; then
    echo "BAD NAME: $f"; fail=1
  fi
  if grep -v '^[[:space:]]*--' "$f" | grep -qiE '\b(drop[[:space:]]+table|drop[[:space:]]+column|drop[[:space:]]+schema|drop[[:space:]]+extension|truncate|delete[[:space:]]+from|alter[[:space:]]+column[[:space:]]+[^[:space:]]+[[:space:]]+type)\b' \
    && ! grep -q -- '-- allow-destructive' "$f"; then
    echo "DESTRUCTIVE: $f"; fail=1
  fi
done
echo "exit=$fail"
```

Expected: `exit=0`. If it reports DESTRUCTIVE, you have written a statement the
guard blocks — rewrite it rather than adding the marker; nothing in this
migration needs one.

- [ ] **Step 4: Update schema.sql to describe the final state**

`supabase/schema.sql` is the readable single-file description of the database,
not an applied artifact. Make these six edits.

**a.** Replace the `entries` block, comment included:

```sql
-- One row per ADD. Several adds may share a day, each with its own rate.
create table if not exists public.entries (
  id         uuid         primary key default gen_random_uuid(),
  week_start date         not null references public.weeks(week_start) on delete cascade,
  day        date         not null,
  qty        integer      not null check (qty > 0),   -- = sum of this add's shares
  rate       numeric(10,4) not null check (rate > 0), -- price per chapati for this add
  amount     numeric(10,2) not null,                  -- = sum of this add's share amounts
  note       text         not null default '',
  created_at timestamptz  not null default now()
);
create index if not exists entries_week_idx on public.entries(week_start);
create index if not exists entries_day_idx  on public.entries(day);
```

**b.** Insert the `users` and `entry_shares` `create table` blocks from Step 2
(without the seed `insert`, which belongs to the migration only) above the
`logs` block.

**c.** Add `target text` to the `logs` block, after `note_after text`, with the
comment `-- the person a user_* action refers to`.

**d.** Extend the three `enable row level security` lines to five, adding
`public.users` and `public.entry_shares`.

**e.** Add the two `drop policy if exists` / `create policy` pairs from Step 2,
and extend the grant to:

```sql
grant select, insert, update, delete on public.weeks, public.entries, public.logs,
  public.users, public.entry_shares to authenticated;
```

**f.** Add `users` and `entry_shares` to the realtime `do $$ ... $$` block, each
as another guarded `if not exists (...) then alter publication ... end if;`
stanza matching the three already there.

- [ ] **Step 5: Commit**

```bash
npm run format
git add supabase/migrations supabase/schema.sql
git commit -m "feat: add users and entry_shares tables, per-add rate"
```

---

## Task 5: DB-backed login

Self-contained and independently verifiable: after this task the gate consults
the database and the repo file is gone, while the ledger still behaves exactly
as before.

**Files:**

- Modify: `supabase/functions/validate-access/index.ts`
- Modify: `supabase/functions/validate-access/deno.json`
- Modify: `src/lib/db.ts` (add two functions only)
- Modify: `src/config.ts`
- Modify: `src/hooks/useAuth.ts`
- Modify: `src/App.tsx` (gate path only)
- Modify: `.github/workflows/deploy.yml`
- Delete: `allowed-names.json`

**Interfaces:**

- Consumes: the `users` table from Task 4
- Produces: `db.loadUsers(): Promise<User[]>`, `db.nameCanLogin(name: string): Promise<boolean>`

- [ ] **Step 1: Add the Supabase client to the edge function's import map**

In `supabase/functions/validate-access/deno.json`, add one entry:

```json
{
  "imports": {
    "@supabase/functions-js": "jsr:@supabase/functions-js@^2",
    "@supabase/server": "npm:@supabase/server@^1",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@^2"
  }
}
```

- [ ] **Step 2: Point the edge function at the users table**

In `supabase/functions/validate-access/index.ts`, add the import at the top:

```ts
import { createClient } from "@supabase/supabase-js";
```

Then replace the entire `── validate name against allowlist ──` block (the
`allowedRaw` / `allowed` / `allowed.length === 0` / `!allowed.includes(clean)`
section) with:

```ts
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
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into every Supabase
edge function automatically — no secret needs setting.

- [ ] **Step 3: Add the two client-side reads**

In `src/lib/db.ts`, add `User` to the type import and append these two functions
next to `validateAccess`:

```ts
/** Everyone on the list — the split composer and People sheet both need it. */
export async function loadUsers(): Promise<User[]> {
  const { data, error } = await supabase.from("users").select("*").order("created_at");
  if (error) fail("loadUsers", error);
  return (data ?? []) as User[];
}

/** Local-dev gate check. Production goes through the edge function instead. */
export async function nameCanLogin(name: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("name", name)
    .eq("can_login", true)
    .limit(1);
  if (error) fail("nameCanLogin", error);
  return (data ?? []).length > 0;
}
```

- [ ] **Step 4: Strip the allowlist out of the frontend**

Replace `src/config.ts` entirely:

```ts
// ─────────────────────────────────────────────────────────────
// The only things you change to run this for your group.
// Who may sign in is no longer configured here — it lives in the `users`
// table and is managed from the People sheet inside the app.
// ─────────────────────────────────────────────────────────────

export const DEFAULT_PRICE = 0.5; // price per chapati at the default rate
export const CURRENCY = "$";
```

In `src/hooks/useAuth.ts`, drop the `ALLOWED_NAMES` import and let `restoreUser`
restore the saved name unconditionally. The gate is what validates a name; a
restored session that shouldn't exist is caught on the next sign-in, and
`localStorage` is not a security boundary in an app whose trust model is a
shared code:

```ts
import { useCallback, useState } from "react";

export function useAuth() {
  const [user, setUser] = useState<string | null>(null);

  /** Restore a previously saved name. Validation happens at the gate. */
  const restoreUser = useCallback(() => {
    const saved = localStorage.getItem("khata.name");
    if (saved) setUser(saved);
  }, []);
```

Leave `signIn`, `signOut` and the return object exactly as they are.

In `src/App.tsx`, remove the `import { ALLOWED_NAMES } from "./config";` line and
change the local-dev branch of `handleGateSubmit` from the array check to the
database check:

```ts
      if (ENTRY_CODE) {
        // Local dev: code from .env, name from the users table
        if (code !== ENTRY_CODE) return "code";
        if (!(await db.nameCanLogin(clean))) return "name";
      } else {
```

- [ ] **Step 5: Delete the file and its CI sync step**

```bash
git rm allowed-names.json
```

In `.github/workflows/deploy.yml`, delete the final step of the
`supabase-deploy` job in its entirety — the five lines beginning
`- name: Sync ALLOWED_NAMES to Supabase secrets` through the
`run: supabase secrets set ALLOWED_NAMES=...` line, comments included.

- [ ] **Step 6: Verify nothing still references the old list**

Run: `grep -rn "ALLOWED_NAMES\|allowed-names" src .github supabase --include="*.ts" --include="*.tsx" --include="*.yml" --include="*.json"`
Expected: no matches. Any hit is a leftover reference that will fail the build.

- [ ] **Step 7: Typecheck, lint, build**

Run: `npm run format && npm run lint && npm run typecheck && npm run build`
Expected: all clean.

- [ ] **Step 8: Manual check**

Run `npm run dev`, sign in with a name from the seeded seven and the dev code.
Expected: the gate opens. Then try a name that is not seeded.
Expected: "Not allowed. Check the spelling, or ask to be added."

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: move the login allowlist into the database"
```

---

## Task 6: The split composer and the add path

The vertical slice that makes a split entry possible: read shares, write an add
with its allocation, and the widget for entering one.

**Files:**

- Modify: `src/lib/db.ts`
- Modify: `src/hooks/useKhataData.ts`
- Create: `src/components/SplitEditor.tsx`
- Modify: `src/components/AddForm.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Interfaces:**

- Consumes: `buildShares`, `sharesAmount`, `evenSplit`, `remaining`, `Alloc`, `ShareInput` (Task 1); `splitMembers` (Task 2); `loadUsers` (Task 5)
- Produces: `db.addEntry(weekId, day, input, actor, deviceId)` where `input` is `{ qty: number; rate: number; note: string; shares: ShareInput[] }`; `useKhataData` now returns `users: User[]`; `<SplitEditor>` props below

- [ ] **Step 1: Replace the add write path in db.ts**

In `src/lib/db.ts`, delete the `AddInput` interface and the whole `addToday`
function, and delete the now-unused `money` and `DEFAULT_PRICE` imports (the
rate-tag note enrichment they served is gone — rate is a stored column). Add:

```ts
export interface EntryInput {
  qty: number;
  rate: number;
  note: string;
  shares: ShareInput[];
}

/**
 * Record one add: a purchase run with its own rate and its own full allocation.
 *
 * Not transactional — supabase-js has no client-side transactions. Shares go in
 * as a single batch statement, so Postgres commits all of them or none, which
 * leaves exactly one reachable bad state: an entry with no shares. If that
 * happens we try to undo the entry; if the undo also fails, `needsRepair` in
 * aggregate.ts catches the orphan and the UI offers to finish or discard it.
 */
export async function addEntry(
  weekId: string,
  day: string,
  input: EntryInput,
  actor: string,
  deviceId: string,
): Promise<void> {
  await ensureWeek(weekId);

  const { data, error } = await supabase
    .from("entries")
    .insert({
      week_start: weekId,
      day,
      qty: input.qty,
      rate: input.rate,
      amount: sharesAmount(input.shares),
      note: input.note,
    })
    .select("id")
    .single();
  if (error) fail("addEntry/insert", error);

  const entryId = (data as { id: string }).id;
  const { error: shareErr } = await supabase
    .from("entry_shares")
    .insert(input.shares.map((s) => ({ ...s, entry_id: entryId })));
  if (shareErr) {
    // Best effort: undo the entry rather than leave it unallocated.
    await supabase.from("entries").delete().eq("id", entryId);
    fail("addEntry/shares", shareErr);
  }

  await logAction({
    actor,
    action: "create",
    week_start: weekId,
    day,
    qty_after: input.qty,
    device_id: deviceId,
  });
}
```

Add `sharesAmount` and `ShareInput` to the imports from `./split`, and extend
`logAction`'s parameter type with `target?: string | null` plus
`target: row.target ?? null` in the inserted object.

- [ ] **Step 2: Embed shares in the reads**

In `src/lib/db.ts`, replace `loadActive` so it pulls users and embeds each
entry's shares in the same round trip:

```ts
// Shares travel with their entry — one round trip, and `needsRepair` can spot
// an entry that lost them without a second query.
const SELECT_ENTRY = "*, entry_shares(*)";

/** Fetch all weeks and users (both tiny), unpaid entries, first page of logs. */
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

In `loadPaidEntries`, change `.select("*")` to `.select(SELECT_ENTRY)`.

Then extend `subscribeChanges` with the two new tables:

```ts
    .on("postgres_changes", { event: "*", schema: "public", table: "entry_shares" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "users" }, onChange)
```

- [ ] **Step 3: Surface users through the data hook**

In `src/hooks/useKhataData.ts`: add `const [users, setUsers] = useState<User[]>([]);`
alongside the other state, add `setUsers(data.users);` inside `load` next to
`setEntries(data.entries);`, add `User` to the type import, and add `users` to
the returned object.

- [ ] **Step 4: Build the split editor**

Create `src/components/SplitEditor.tsx`:

```tsx
import type { User } from "../types";
import type { Alloc } from "../lib/split";
import { allocated, evenSplit, remaining } from "../lib/split";
import { cap } from "../lib/util";

interface Props {
  /** People to offer, already filtered and ordered by the caller. */
  members: User[];
  /** The add's total — what the allocation must add up to. */
  total: number;
  rows: Alloc;
  onChange: (rows: Alloc) => void;
  /** Numbers from the previous add, for the "Same as last" fill. Null hides it. */
  lastAdd: Alloc | null;
  disabled?: boolean;
}

/**
 * Allocate a known total across people. Controlled — the parent owns the
 * allocation and decides what to do with it; this only edits it and shows how
 * far off it is.
 */
export function SplitEditor({ members, total, rows, onChange, lastAdd, disabled }: Props) {
  const left = remaining(total, rows);

  function setOne(id: string, raw: string) {
    const digits = raw.replace(/[^0-9]/g, "");
    onChange({ ...rows, [id]: digits === "" ? 0 : parseInt(digits, 10) });
  }

  return (
    <div className="split">
      <div className="split-fills">
        <button
          className="btn btn-ghost split-fill"
          disabled={disabled || total <= 0 || members.length === 0}
          onClick={() =>
            onChange(
              evenSplit(
                total,
                members.map((m) => m.id),
              ),
            )
          }
        >
          Even split
        </button>
        {lastAdd && (
          <button
            className="btn btn-ghost split-fill"
            disabled={disabled}
            onClick={() => onChange({ ...lastAdd })}
          >
            Same as last
          </button>
        )}
        <button
          className="btn btn-ghost split-fill"
          disabled={disabled || allocated(rows) === 0}
          onClick={() => onChange({})}
        >
          Clear
        </button>
      </div>

      {members.length === 0 ? (
        <div className="split-empty">Nobody is in the split. Add people first.</div>
      ) : (
        <ul className="split-rows">
          {members.map((m) => (
            <li key={m.id} className="split-row">
              <span className="split-name">{cap(m.name)}</span>
              <input
                className="in split-qty"
                inputMode="numeric"
                value={rows[m.id] ? String(rows[m.id]) : ""}
                placeholder="0"
                disabled={disabled}
                onChange={(e) => setOne(m.id, e.target.value)}
                aria-label={`Chapatis for ${m.name}`}
              />
            </li>
          ))}
        </ul>
      )}

      <div className={"split-left" + (left === 0 ? " ok" : left < 0 ? " over" : "")}>
        {total <= 0
          ? "Enter a total first"
          : left === 0
            ? "All allocated"
            : left > 0
              ? `${left} left to allocate`
              : `${-left} over-allocated`}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Turn AddForm into the composer**

Replace `src/components/AddForm.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import type { Entry, User, Week } from "../types";
import type { Alloc, ShareInput } from "../lib/split";
import { buildShares, remaining } from "../lib/split";
import { splitMembers } from "../lib/people";
import { DEFAULT_PRICE } from "../config";
import { dayLabel, money, parseQty, sanitizeQty, todayStr, weekIdOf } from "../lib/util";
import { IcPlus } from "./icons";
import { SplitEditor } from "./SplitEditor";

interface Props {
  entries: Entry[];
  weeks: Week[];
  users: User[];
  busy: boolean;
  onAdd: (
    input: { qty: number; rate: number; note: string; shares: ShareInput[] },
    date: string,
  ) => Promise<boolean>;
}

export function AddForm({ entries, weeks, users, busy, onAdd }: Props) {
  const [qtyRaw, setQtyRaw] = useState("");
  const [noteRaw, setNoteRaw] = useState("");
  const [addErr, setAddErr] = useState("");
  const [rows, setRows] = useState<Alloc>({});
  const today = todayStr();
  const [selectedDate, setSelectedDate] = useState(today);

  const isToday = selectedDate === today;
  const members = useMemo(() => splitMembers(users), [users]);
  const parsed = useMemo(() => parseQty(qtyRaw), [qtyRaw]);
  const total = parsed?.qty ?? 0;

  const { weekPaid, dayAdds } = useMemo(() => {
    const wid = weekIdOf(selectedDate);
    return {
      weekPaid: weeks.find((w) => w.week_start === wid)?.paid ?? false,
      dayAdds: entries.filter((e) => e.day === selectedDate),
    };
  }, [selectedDate, weeks, entries]);

  // Numbers from the most recent add anywhere, for the "Same as last" fill.
  const lastAdd = useMemo(() => {
    const latest = [...entries].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!latest || latest.entry_shares.length === 0) return null;
    const out: Alloc = {};
    for (const s of latest.entry_shares) out[s.user_id] = s.qty;
    return out;
  }, [entries]);

  // Prefill only on a day's first add. A same-day top-up starts blank: the
  // morning's 45-across-seven is the wrong shape for an evening 20-across-two.
  //
  // The ref primes at most once per date. Without it, the realtime refresh that
  // follows every change anywhere would wipe an allocation as you were typing
  // it — and on first paint there is no data to prime from yet.
  const primedFor = useRef<string | null>(null);
  useEffect(() => {
    if (primedFor.current === selectedDate) return;
    if (users.length === 0) return; // nothing loaded yet
    primedFor.current = selectedDate;
    setRows(dayAdds.length === 0 && lastAdd ? { ...lastAdd } : {});
  }, [selectedDate, users.length, dayAdds.length, lastAdd]);

  const left = remaining(total, rows);
  const canAdd = total > 0 && left === 0 && !busy;

  async function handleAdd() {
    setAddErr("");
    if (weekPaid) {
      setAddErr("This week is marked paid. Reopen it to add more.");
      return;
    }
    if (!parsed) {
      setAddErr("Enter a number like 5");
      return;
    }
    const shares = buildShares(rows, parsed.price);
    if (shares.length === 0) {
      setAddErr("Give at least one person some chapatis");
      return;
    }
    const note = noteRaw.trim().slice(0, 60);
    const ok = await onAdd({ qty: parsed.qty, rate: parsed.price, note, shares }, selectedDate);
    if (ok) {
      setQtyRaw("");
      setNoteRaw("");
      setRows({});
    }
  }

  return (
    <section className="add">
      <div className="add-head">
        <span className="eyebrow">Add entry</span>
        <div className="add-date-wrap">
          <input
            type="date"
            className="add-date-pick"
            value={selectedDate}
            max={today}
            onChange={(e) => {
              setSelectedDate(e.target.value || today);
              setAddErr("");
            }}
            aria-label="Entry date"
          />
          {isToday && <span className="add-today-tag">today</span>}
        </div>
      </div>
      <div className="add-row">
        <input
          className="in qty"
          inputMode="text"
          placeholder="How many?"
          value={qtyRaw}
          onChange={(e) => {
            setQtyRaw(sanitizeQty(e.target.value));
            setAddErr("");
          }}
          aria-label="Chapati count"
        />
        <button
          className="btn btn-solid add-btn"
          disabled={!canAdd}
          onClick={handleAdd}
          aria-label="Add entry"
        >
          <IcPlus className="ic" />
          <span>Add</span>
        </button>
      </div>

      <SplitEditor
        members={members}
        total={total}
        rows={rows}
        onChange={setRows}
        lastAdd={lastAdd}
        disabled={busy}
      />

      <input
        className="in note"
        placeholder="Note (optional)"
        value={noteRaw}
        maxLength={60}
        onChange={(e) => setNoteRaw(e.target.value)}
        aria-label="Optional note"
      />
      {addErr && <div className="add-err">{addErr}</div>}
      {!addErr &&
        (dayAdds.length > 0 ? (
          <div className="add-hint">
            {isToday ? "Today" : dayLabel(selectedDate)} so far &middot;{" "}
            <b>{dayAdds.reduce((s, e) => s + e.qty, 0)}</b> chapatis &middot;{" "}
            {money(dayAdds.reduce((s, e) => s + e.amount, 0))}
          </div>
        ) : (
          <div className="add-rate">{money(parsed?.price ?? DEFAULT_PRICE)} per chapati</div>
        ))}
    </section>
  );
}
```

Note the Enter-key handlers are gone from the qty and note inputs: with an
allocation to fill in, Enter submitting a half-filled form is a trap rather than
a shortcut.

- [ ] **Step 6: Rewire App.tsx's add handler**

In `src/App.tsx`, pull `users` out of `useKhataData()`, replace `handleAdd`, and
pass `users` to `<AddForm>`:

```tsx
async function handleAdd(
  input: { qty: number; rate: number; note: string; shares: ShareInput[] },
  date: string,
): Promise<boolean> {
  if (!user) return false;
  const weekId = weekIdOf(date);
  const isToday = date === todayStr();
  return withBusy(async () => {
    await db.addEntry(weekId, date, input, user, device);
    flash(`${isToday ? "Today" : dayLabel(date)} logged`);
  });
}
```

Update the import line from `import type { ParsedQty } from "./lib/util";` to
`import type { ShareInput } from "./lib/split";` and change the JSX to
`<AddForm entries={entries} weeks={weeks} users={users} busy={busy} onAdd={handleAdd} />`.

- [ ] **Step 7: Style the composer**

Append to `src/styles.css`:

```css
/* ── split composer ── */
.split {
  margin-top: 10px;
}
.split-fills {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.btn.split-fill {
  padding: 8px 12px;
  font-size: 13px;
  min-height: 36px;
  border-radius: 10px;
}
.split-rows {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.split-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.split-name {
  flex: 1;
  font-size: 14.5px;
  color: var(--ink);
}
.in.split-qty {
  width: 78px;
  flex-shrink: 0;
  text-align: center;
  font-family: var(--mono);
  font-weight: 700;
  padding: 9px 8px;
}
.split-left {
  margin-top: 10px;
  font-size: 13px;
  font-weight: 700;
  color: var(--soft);
  font-family: var(--mono);
}
.split-left.ok {
  color: var(--herb);
}
.split-left.over {
  color: var(--brick);
}
.split-empty {
  font-size: 13px;
  color: var(--soft);
  padding: 8px 2px;
}
```

- [ ] **Step 8: Verify**

Run: `npm run format && npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all clean, 41 tests passing.

Then `npm run dev` and check: the composer lists the seven seeded people; typing
a total shows "N left to allocate"; **Add** stays disabled until it reads
"All allocated"; **Even split** fills and reconciles in one tap; adding a second
entry the same day opens blank while a fresh day prefills.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: split each add across people when logging an entry"
```

---

## Task 7: Editing and deleting an add

**Files:**

- Modify: `src/lib/db.ts`
- Modify: `src/components/EditSheet.tsx`
- Modify: `src/App.tsx`

**Interfaces:**

- Consumes: `buildShares`, `remaining` (Task 1); `splitMembers` (Task 2); `EntryInput` and `SplitEditor` (Task 6)
- Produces: `db.editEntry(entry, input, actor, deviceId)`; `deleteEntry` keeps its signature

- [ ] **Step 1: Replace editEntry in db.ts**

Delete the existing `editEntry` (with its blended-rate `eff` calculation — the
rate is stored now) and add:

```ts
/**
 * Replace an add's total, rate, note and allocation.
 *
 * Ordering rule: never delete existing shares before their replacements are
 * written. No ordering avoids a transient mismatch without a transaction, but
 * this one makes the transient state an over-allocation — visible and
 * repairable — rather than a loss of attribution.
 */
export async function editEntry(
  entry: Entry,
  input: EntryInput,
  actor: string,
  deviceId: string,
): Promise<void> {
  const { error: upErr } = await supabase.from("entry_shares").upsert(
    input.shares.map((s) => ({ ...s, entry_id: entry.id })),
    {
      onConflict: "entry_id,user_id",
    },
  );
  if (upErr) fail("editEntry/shares", upErr);

  // Prune anyone dropped from the allocation. `keep` is never empty in practice
  // — the editor blocks saving a total of zero — but an empty `in ()` list is
  // invalid PostgREST, so branch rather than emit one.
  const keep = input.shares.map((s) => s.user_id);
  const prune = supabase.from("entry_shares").delete().eq("entry_id", entry.id);
  const { error: delErr } = await (keep.length > 0
    ? prune.not("user_id", "in", `(${keep.join(",")})`)
    : prune);
  if (delErr) fail("editEntry/prune", delErr);

  const { error } = await supabase
    .from("entries")
    .update({
      qty: input.qty,
      rate: input.rate,
      amount: sharesAmount(input.shares),
      note: input.note,
    })
    .eq("id", entry.id);
  if (error) fail("editEntry", error);

  const noteChanged = entry.note !== input.note;
  await logAction({
    actor,
    action: "edit",
    week_start: entry.week_start,
    day: entry.day,
    qty_before: entry.qty,
    qty_after: input.qty,
    note_before: noteChanged ? entry.note : null,
    note_after: noteChanged ? input.note : null,
    device_id: deviceId,
  });
}
```

`deleteEntry` needs no change — `on delete cascade` takes the shares with it.

- [ ] **Step 2: Rebuild EditSheet around the composer**

Replace `src/components/EditSheet.tsx`:

```tsx
import { useMemo, useState } from "react";
import type { Entry, User } from "../types";
import type { Alloc, ShareInput } from "../lib/split";
import { buildShares, remaining } from "../lib/split";
import { splitMembers } from "../lib/people";
import { DEFAULT_PRICE } from "../config";
import { dayLabel, money, parseQty, sanitizeQty } from "../lib/util";
import { IcTrash, IcX } from "./icons";
import { SplitEditor } from "./SplitEditor";

interface Props {
  entry: Entry;
  users: User[];
  busy: boolean;
  onClose: () => void;
  onSave: (
    entry: Entry,
    input: { qty: number; rate: number; note: string; shares: ShareInput[] },
  ) => void;
  onDelete: (entry: Entry) => void;
}

export function EditSheet({ entry, users, busy, onClose, onSave, onDelete }: Props) {
  const [qtyRaw, setQtyRaw] = useState(
    entry.rate === DEFAULT_PRICE ? String(entry.qty) : `${entry.qty}x${entry.rate}`,
  );
  const [note, setNote] = useState(entry.note ?? "");
  const [askDel, setAskDel] = useState(false);
  const [rows, setRows] = useState<Alloc>(() => {
    const out: Alloc = {};
    for (const s of entry.entry_shares) out[s.user_id] = s.qty;
    return out;
  });

  // Anyone already in this add stays editable even if their split switch has
  // since been turned off — history is never rewritten by a status change.
  // Derived from the stored shares, not the live `rows`: zeroing someone out
  // must not make their row vanish out from under you mid-edit.
  const members = useMemo(() => {
    const inSplit = splitMembers(users);
    const seen = new Set(inSplit.map((m) => m.id));
    const held = new Set(entry.entry_shares.map((s) => s.user_id));
    return [...inSplit, ...users.filter((u) => !seen.has(u.id) && held.has(u.id))];
  }, [users, entry.entry_shares]);

  const parsed = parseQty(qtyRaw);
  const total = parsed?.qty ?? 0;
  const valid = total > 0 && remaining(total, rows) === 0;

  return (
    <div className="ovl" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h3 className="sheet-t">{dayLabel(entry.day)}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IcX className="ic" />
          </button>
        </div>

        <label className="fld-l">Total this add</label>
        <input
          className="in"
          inputMode="text"
          value={qtyRaw}
          autoFocus
          onChange={(e) => setQtyRaw(sanitizeQty(e.target.value))}
          aria-label="Chapati count"
        />
        <div className="add-rate">{money(parsed?.price ?? entry.rate)} per chapati</div>

        <label className="fld-l">Who had them</label>
        <SplitEditor
          members={members}
          total={total}
          rows={rows}
          onChange={setRows}
          lastAdd={null}
          disabled={busy}
        />

        <label className="fld-l">Note</label>
        <input
          className="in"
          value={note}
          placeholder="Optional"
          onChange={(e) => setNote(e.target.value)}
          aria-label="Note"
        />

        {!askDel ? (
          <div className="sheet-a">
            <button className="btn btn-danger-ghost" onClick={() => setAskDel(true)}>
              <IcTrash className="ic sm" />
              Delete
            </button>
            <button
              className="btn btn-solid"
              disabled={!valid || busy}
              onClick={() =>
                parsed &&
                onSave(entry, {
                  qty: parsed.qty,
                  rate: parsed.price,
                  note,
                  shares: buildShares(rows, parsed.price),
                })
              }
            >
              Save changes
            </button>
          </div>
        ) : (
          <div className="del-confirm">
            <span>Delete this entry? It stays in the log.</span>
            <div className="sheet-a">
              <button className="btn btn-ghost" onClick={() => setAskDel(false)}>
                Keep
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => onDelete(entry)}>
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Rewire App.tsx's save handler**

```tsx
async function handleSaveEdit(
  entry: Entry,
  input: { qty: number; rate: number; note: string; shares: ShareInput[] },
) {
  if (!user) return;
  await withBusy(async () => {
    await db.editEntry(entry, { ...input, note: input.note.trim() }, user, device);
    setEditing(null);
    flash("Entry updated");
  });
}
```

And pass users to the sheet: `<EditSheet entry={editing} users={users} busy={busy} ... />`.

- [ ] **Step 4: Verify**

Run: `npm run format && npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all clean.

Then `npm run dev`: open an add, change its total, watch **Save changes** grey
out until the allocation reconciles, save, and confirm the per-person numbers
changed. Delete an add and confirm it disappears.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: edit an add's split, total and rate"
```

---

## Task 8: Ledger display

Days group their adds, splits are visible, each week carries a per-person
subtotal, and a half-written add offers to be repaired.

**Files:**

- Modify: `src/components/WeekCard.tsx`
- Modify: `src/hooks/useKhataData.ts`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Interfaces:**

- Consumes: `groupByDay`, `perPerson`, `needsRepair`, `nameOf` (Task 3)
- Produces: `<WeekCard>` gains `users` and `onDiscard` props

- [ ] **Step 1: Rewrite WeekCard**

Replace `src/components/WeekCard.tsx`:

```tsx
import { useState } from "react";
import type { Entry, User, WeekView } from "../types";
import { groupByDay, nameOf, needsRepair, perPerson } from "../lib/aggregate";
import { cap, dayLabel, isCurrentWeek, money, stamp, weekLabel } from "../lib/util";
import { IcCheck, IcLock, IcPencil } from "./icons";

interface Props {
  w: WeekView;
  users: User[];
  busy: boolean;
  onEntry: (entry: Entry) => void;
  onDiscard: (entry: Entry) => void;
  onPay: () => void;
  onReopen: () => void;
}

const CURRENT_YEAR = String(new Date().getFullYear());

export function WeekCard({ w, users, busy, onEntry, onDiscard, onPay, onReopen }: Props) {
  const [openAdd, setOpenAdd] = useState<string | null>(null);
  const days = groupByDay(w.entries);
  const people = perPerson(w.entries);
  const showYear = w.week_start.slice(0, 4) !== CURRENT_YEAR;

  return (
    <section
      className={"week" + (w.paid ? " paid" : "") + (isCurrentWeek(w.week_start) ? " now" : "")}
    >
      <div className="perf" />
      <div className="week-head">
        <div>
          <div className="week-range">
            {weekLabel(w.week_start, showYear)}
            {isCurrentWeek(w.week_start) && <span className="tag-now">this week</span>}
          </div>
          <div className="week-meta">
            <b>{money(w.total)}</b>
            <span className="dot">·</span>
            {w.count} chapati{w.count !== 1 ? "s" : ""}
          </div>
        </div>
        {w.paid ? (
          <span className="badge-paid">
            <IcCheck className="ic sm" />
            Paid
          </span>
        ) : (
          <button className="btn btn-pay" disabled={busy} onClick={onPay}>
            Mark paid
          </button>
        )}
      </div>

      <ul className="rows">
        {days.map((d) => (
          <li key={d.day} className="day">
            <div className="day-head">
              <span className="row-day">{dayLabel(d.day)}</span>
              <span className="day-tot">
                {d.qty} chapati{d.qty !== 1 ? "s" : ""}
              </span>
              <span className="row-amt">{money(d.amount)}</span>
            </div>

            {d.adds.map((e) => {
              const broken = needsRepair(e);
              const open = openAdd === e.id;
              return (
                <div key={e.id} className={"add-line" + (broken ? " broken" : "")}>
                  <button
                    className="add-line-main"
                    onClick={() => setOpenAdd(open ? null : e.id)}
                    aria-expanded={open}
                  >
                    <span className="add-line-qty">
                      {e.qty} @ {money(e.rate)}
                    </span>
                    {e.note && <span className="row-note">{e.note}</span>}
                    <span className="row-amt">{money(e.amount)}</span>
                  </button>

                  {!w.paid && (
                    <button
                      className="icon-btn add-line-edit"
                      onClick={() => onEntry(e)}
                      aria-label="Edit this add"
                    >
                      <IcPencil className="ic sm" />
                    </button>
                  )}

                  {broken && (
                    <div className="repair">
                      <span>This add was not fully split.</span>
                      <div className="repair-a">
                        <button className="link" disabled={busy} onClick={() => onEntry(e)}>
                          Finish split
                        </button>
                        <button
                          className="link danger"
                          disabled={busy}
                          onClick={() => onDiscard(e)}
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  )}

                  {open && !broken && (
                    <ul className="share-rows">
                      {e.entry_shares.map((s) => (
                        <li key={s.user_id} className="share-row">
                          <span className="share-name">{cap(nameOf(users, s.user_id))}</span>
                          <span className="share-qty">{s.qty}</span>
                          <span className="share-amt">{money(s.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </li>
        ))}
      </ul>

      {people.length > 0 && (
        <div className="week-people">
          <div className="week-people-t">Per person this week</div>
          <ul className="share-rows">
            {people.map((p) => (
              <li key={p.userId} className="share-row">
                <span className="share-name">{cap(nameOf(users, p.userId))}</span>
                <span className="share-qty">{p.qty}</span>
                <span className="share-amt">{money(p.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
    </section>
  );
}
```

- [ ] **Step 2: Thread users through**

`src/components/PaidHistory.tsx` forwards props to `WeekCard`. Add
`users: User[];` to its `Props`, accept it in the destructured parameter list,
add `User` to its type import, and pass both down on the `<WeekCard>` it
renders:

```tsx
<WeekCard
  w={w}
  users={users}
  busy={busy}
  onEntry={onEntry}
  onDiscard={() => {}}
  onPay={() => {}}
  onReopen={() => onReopen(w.week_start)}
/>
```

`onDiscard` is a no-op there: a paid week's adds are locked, so the repair
actions are unreachable until the week is reopened.

In `src/App.tsx`, pass `users={users}` to both `<WeekCard>` and `<PaidHistory>`,
and give the ledger's `<WeekCard>` `onDiscard={handleDeleteEntry}`.

- [ ] **Step 3: Count chapatis from adds, not day rows**

`useKhataData`'s `weekViews` already sums `e.qty` and `e.amount` across
entries, and several adds per day sum correctly with no change. Verify by
reading `src/hooks/useKhataData.ts` lines 121-147 — no edit expected.

- [ ] **Step 4: Style it**

Append to `src/styles.css`:

```css
/* ── day / add / share rows ── */
.day {
  border-top: 1px dashed var(--line);
  padding: 8px 8px 10px;
}
.day-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.day-tot {
  flex: 1;
  font-size: 13px;
  color: var(--soft);
}
.add-line {
  position: relative;
  margin: 6px 0 0 78px;
  padding-right: 40px;
}
.add-line-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: none;
  padding: 6px 0;
  min-height: 36px;
}
.add-line-qty {
  font-family: var(--mono);
  font-size: 14px;
  color: var(--ink);
  flex: 1;
}
.add-line-edit {
  position: absolute;
  top: 2px;
  right: 0;
}
.add-line.broken {
  background: var(--brick-tint);
  border-radius: 8px;
  padding: 4px 8px;
}
.repair {
  font-size: 12.5px;
  color: var(--brick);
  padding: 4px 0 6px;
}
.repair-a {
  display: flex;
  gap: 14px;
  margin-top: 4px;
}
.link.danger {
  color: var(--brick);
}
.share-rows {
  list-style: none;
  padding: 4px 0 2px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.share-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}
.share-name {
  flex: 1;
  color: var(--soft);
}
.share-qty {
  font-family: var(--mono);
  color: var(--ink);
  width: 32px;
  text-align: right;
}
.share-amt {
  font-family: var(--mono);
  color: var(--ink);
  width: 60px;
  text-align: right;
}
.week-people {
  border-top: 1px dashed var(--line);
  padding: 10px 16px;
}
.week-people-t {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
  margin-bottom: 6px;
}
```

- [ ] **Step 5: Verify**

Run: `npm run format && npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all clean.

Then `npm run dev`: add two entries on the same day at different rates. The day
shows one heading with a combined total and two add lines each showing its own
rate. Tapping an add reveals its split; the week card shows a per-person
subtotal where each person's money is the sum of both runs, not a blend.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: show days, adds and per-person totals in the ledger"
```

---

## Task 9: People management

**Files:**

- Modify: `src/lib/db.ts`
- Create: `src/components/PeopleSheet.tsx`
- Modify: `src/components/Header.tsx`
- Modify: `src/components/icons.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Interfaces:**

- Consumes: `canDelete`, `canRevokeLogin`, `sortPeople` (Task 2)
- Produces: `db.addPerson`, `db.setPersonFlag`, `db.deletePerson`, `db.hasShares`

- [ ] **Step 1: Add the people writes to db.ts**

```ts
/** Add someone. Names are lowercased and trimmed, as the gate expects. */
export async function addPerson(name: string, actor: string, deviceId: string): Promise<void> {
  const clean = name.trim().toLowerCase();
  const { error } = await supabase.from("users").insert({ name: clean });
  if (error) fail("addPerson", error);
  await logAction({ actor, action: "user_add", target: clean, device_id: deviceId });
}

/** Flip one of a person's two switches. */
export async function setPersonFlag(
  user: User,
  field: "in_split" | "can_login",
  value: boolean,
  actor: string,
  deviceId: string,
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({ [field]: value })
    .eq("id", user.id);
  if (error) fail("setPersonFlag", error);
  const action: LogAction =
    field === "in_split"
      ? value
        ? "user_split_on"
        : "user_split_off"
      : value
        ? "user_login_on"
        : "user_login_off";
  await logAction({ actor, action, target: user.name, device_id: deviceId });
}

/**
 * Permanently remove someone. Only reachable for a person holding no shares —
 * the database refuses the rest via `on delete restrict`, so a bug here becomes
 * an error rather than orphaned history.
 */
export async function deletePerson(user: User, actor: string, deviceId: string): Promise<void> {
  const { error } = await supabase.from("users").delete().eq("id", user.id);
  if (error) fail("deletePerson", error);
  await logAction({ actor, action: "user_delete", target: user.name, device_id: deviceId });
}

/** Does this person appear in any add? Decides whether deletion is offered. */
export async function hasShares(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("entry_shares")
    .select("entry_id")
    .eq("user_id", userId)
    .limit(1);
  if (error) fail("hasShares", error);
  return (data ?? []).length > 0;
}
```

Add `LogAction` and `User` to the type imports at the top of the file.

> Refinement on spec §8: the spec called for one aggregate query counting shares
> per person. An existence check for the single person being considered is
> strictly less data for the same behaviour, so that is what this does.

- [ ] **Step 2: Add a people icon**

In `src/components/icons.tsx`, following the existing icon pattern, add:

```tsx
export const IcPeople = (p: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...p}>
    <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" strokeLinecap="round" />
    <circle cx="9" cy="7" r="3.2" />
    <path d="M22 19v-1a4 4 0 0 0-3-3.87M17 3.6a4 4 0 0 1 0 7.75" strokeLinecap="round" />
  </svg>
);
```

- [ ] **Step 3: Build the sheet**

Create `src/components/PeopleSheet.tsx`:

```tsx
import { useState } from "react";
import type { User } from "../types";
import { canDelete, canRevokeLogin, sortPeople } from "../lib/people";
import * as db from "../lib/db";
import { cap } from "../lib/util";
import { IcTrash, IcX } from "./icons";

interface Props {
  users: User[];
  actor: string;
  busy: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
  deviceId: string;
}

export function PeopleSheet({ users, actor, busy, onClose, onChanged, onError, deviceId }: Props) {
  const [newName, setNewName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);
  const [working, setWorking] = useState(false);
  const people = sortPeople(users);

  async function run(fn: () => Promise<void>) {
    if (working) return;
    setWorking(true);
    try {
      await fn();
      await onChanged();
    } catch {
      onError("Could not save that. Check your connection.");
    } finally {
      setWorking(false);
    }
  }

  async function handleAdd() {
    const clean = newName.trim().toLowerCase();
    if (!clean) return;
    if (people.some((p) => p.name === clean)) {
      onError(`${cap(clean)} is already on the list.`);
      return;
    }
    await run(async () => {
      await db.addPerson(clean, actor, deviceId);
      setNewName("");
    });
  }

  /** Deletion is offered only once we know the person holds no history. */
  async function askDelete(u: User) {
    const held = await db.hasShares(u.id);
    if (!canDelete(held)) {
      onError(`${cap(u.name)} appears in past entries and cannot be deleted.`);
      return;
    }
    setPendingDelete(u);
  }

  const locked = busy || working;

  return (
    <div className="ovl" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h3 className="sheet-t">People</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IcX className="ic" />
          </button>
        </div>

        <div className="ppl-legend">
          <span>In split</span>
          <span>Can log in</span>
        </div>

        <ul className="ppl">
          {people.map((u) => {
            const mayRevoke = canRevokeLogin(u, actor, users);
            return (
              <li key={u.id} className="ppl-row">
                <span className="ppl-name">{cap(u.name)}</span>

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
                  disabled={locked}
                  onClick={() => askDelete(u)}
                  aria-label={`Delete ${u.name}`}
                >
                  <IcTrash className="ic sm" />
                </button>
              </li>
            );
          })}
        </ul>

        <label className="fld-l">Add someone</label>
        <div className="add-row">
          <input
            className="in"
            placeholder="First name"
            value={newName}
            autoComplete="off"
            disabled={locked}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New person's first name"
          />
          <button
            className="btn btn-solid"
            disabled={locked || !newName.trim()}
            onClick={handleAdd}
          >
            Add
          </button>
        </div>

        {pendingDelete && (
          <div className="del-confirm">
            <span>Delete {cap(pendingDelete.name)}? They have no entries, so nothing is lost.</span>
            <div className="sheet-a">
              <button className="btn btn-ghost" onClick={() => setPendingDelete(null)}>
                Keep
              </button>
              <button
                className="btn btn-danger"
                disabled={locked}
                onClick={() =>
                  run(async () => {
                    await db.deletePerson(pendingDelete, actor, deviceId);
                    setPendingDelete(null);
                  })
                }
              >
                Delete
              </button>
            </div>
          </div>
        )}

        <div className="ppl-note">
          Turning off <b>In split</b> keeps someone's history and their access, but stops offering
          them when you add an entry. Turning off <b>Can log in</b> removes their access. Neither
          ever changes a past entry.
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the entry point**

In `src/components/Header.tsx`, add `onPeopleClick: () => void;` to `Props`,
accept it, import `IcPeople`, and add a button before the export button:

```tsx
<button className="icon-btn" onClick={onPeopleClick} aria-label="People">
  <IcPeople className="ic" />
</button>
```

In `src/App.tsx`: add `const [showPeople, setShowPeople] = useState(false);`,
pass `onPeopleClick={() => setShowPeople(true)}` to `<Header>`, and render the
sheet next to the others:

```tsx
{
  showPeople && user && (
    <PeopleSheet
      users={users}
      actor={user}
      busy={busy}
      deviceId={device}
      onClose={() => setShowPeople(false)}
      onChanged={load}
      onError={flash}
    />
  );
}
```

- [ ] **Step 5: Style it**

Append to `src/styles.css`:

```css
/* ── people sheet ── */
.ppl-legend {
  display: flex;
  justify-content: flex-end;
  gap: 22px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--faint);
  padding-right: 44px;
  margin-bottom: 6px;
}
.ppl {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.ppl-row {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 9px 0;
  border-top: 1px dashed var(--line);
  min-height: 44px;
}
.ppl-name {
  flex: 1;
  font-size: 15px;
}
.ppl-box {
  width: 20px;
  height: 20px;
  accent-color: var(--marigold);
  flex-shrink: 0;
}
.ppl-box:disabled {
  opacity: 0.4;
}
.ppl-note {
  margin-top: 14px;
  font-size: 12.5px;
  color: var(--soft);
  line-height: 1.5;
}
```

- [ ] **Step 6: Verify**

Run: `npm run format && npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all clean.

Then `npm run dev` and check each rule by hand:

- adding a person makes them appear in the composer immediately
- turning off **In split** removes them from the composer but they can still log in
- your own **Can log in** box is disabled with an explanatory tooltip
- turning every other person's login off disables the last remaining box
- deleting a person with entries is refused with a message; deleting a freshly
  added one succeeds

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: manage people from inside the app"
```

---

## Task 10: Per-person stats

**Files:**

- Modify: `src/components/StatsSheet.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Interfaces:**

- Consumes: `perPerson`, `nameOf` (Task 3)
- Produces: `<StatsSheet>` gains a `users` prop

- [ ] **Step 1: Add the per-person section**

In `src/components/StatsSheet.tsx`:

Add `users: User[];` to `Props` and accept it. Add the imports:

```tsx
import type { Entry, User } from "../types";
import { nameOf, perPerson } from "../lib/aggregate";
import { cap, money, round2 } from "../lib/util";
```

Add two memos after the existing `stats` memo:

```tsx
const monthPeople = useMemo(
  () => (key ? perPerson(entries.filter((e) => e.day.slice(0, 7) === key)) : []),
  [entries, key],
);

const lifetime = useMemo(() => perPerson(entries), [entries]);
```

Then insert this block after the closing `</div>` of `.stats-grid`, inside the
sheet:

```tsx
{
  monthPeople.length > 0 && (
    <div className="stats-people">
      <div className="week-people-t">This month, per person</div>
      <ul className="share-rows">
        {monthPeople.map((p) => (
          <li key={p.userId} className="share-row">
            <span className="share-name">{cap(nameOf(users, p.userId))}</span>
            <span className="share-qty">{p.qty}</span>
            <span className="share-amt">{money(p.amount)}</span>
            <span className="share-rate">{money(p.qty > 0 ? round2(p.amount / p.qty) : 0)}/ea</span>
          </li>
        ))}
      </ul>

      <div className="week-people-t stats-life">Lifetime</div>
      <ul className="share-rows">
        {lifetime.map((p) => (
          <li key={p.userId} className="share-row">
            <span className="share-name">{cap(nameOf(users, p.userId))}</span>
            <span className="share-qty">{p.qty}</span>
            <span className="share-amt">{money(p.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Pass users in**

In `src/App.tsx`:
`<StatsSheet entries={allEntries} users={users} onClose={() => setShowStats(false)} />`

- [ ] **Step 3: Style it**

Append to `src/styles.css`:

```css
.stats-people {
  margin-top: 18px;
}
.stats-life {
  margin-top: 16px;
}
.share-rate {
  font-family: var(--mono);
  color: var(--faint);
  font-size: 12px;
  width: 62px;
  text-align: right;
}
```

- [ ] **Step 4: Verify, then commit**

```bash
npm run format && npm run lint && npm run typecheck && npm run test && npm run build
```

Then `npm run dev`, open Stats, and confirm both per-person tables render with
sensible effective rates.

```bash
git add -A
git commit -m "feat: add per-person figures to monthly stats"
```

---

## Task 11: Log actions and backup

**Files:**

- Modify: `src/components/LogView.tsx`
- Modify: `src/App.tsx`

**Interfaces:**

- Consumes: the extended `LogAction` union (Task 1), `logs.target` (Task 4)

- [ ] **Step 1: Render the people actions**

In `src/components/LogView.tsx`, add these cases to `logText` before `default`:

```ts
    case "user_add":
      return `added ${ev.target ?? "someone"}`;
    case "user_delete":
      return `deleted ${ev.target ?? "someone"}`;
    case "user_split_on":
      return `put ${ev.target ?? "someone"} in the split`;
    case "user_split_off":
      return `took ${ev.target ?? "someone"} out of the split`;
    case "user_login_on":
      return `gave ${ev.target ?? "someone"} access`;
    case "user_login_off":
      return `revoked ${ev.target ?? "someone"}'s access`;
```

And extend the `KIND` map:

```ts
  user_add: "c-people",
  user_delete: "c-del",
  user_split_on: "c-people",
  user_split_off: "c-people",
  user_login_on: "c-people",
  user_login_off: "c-del",
```

Add a colour for the new dot class in `src/styles.css`, next to the existing
`.c-*` rules:

```css
.log-dot.c-people {
  background: var(--herb);
}
```

- [ ] **Step 2: Include the new tables in the backup**

In `src/App.tsx`'s `exportJSON`, add `users` to the payload. `entries` already
carries `entry_shares` embedded from the read path, so shares travel with it:

```tsx
const payload = { exported_at: new Date().toISOString(), weeks, users, entries, logs };
```

- [ ] **Step 3: Verify**

Run: `npm run format && npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all clean.

Then `npm run dev`: add and deactivate a person, switch to the Log tab, and
confirm both actions read as sentences naming the person. Download a backup and
confirm the JSON contains `users` and that entries carry `entry_shares`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: log people changes and include them in backups"
```

---

## Release steps

Not part of the tasks above. Do these deliberately, in this order.

- [ ] **1. Open the PR and let CI pass.** `ci.yml` runs the migration lint,
      typecheck, lint, format check, tests and a build. Everything must be green.

- [ ] **2. Wipe the data.** In the Supabase SQL editor, immediately before
      merging. Irreversible.

```sql
delete from public.weeks;   -- cascades entries
delete from public.logs;
```

Kept out of the migration deliberately: as SQL in `supabase/migrations/` this
would be a `delete from`, which the CI guard blocks without an
`-- allow-destructive` marker, and it would sit in history forever being
re-validated on every run to describe a one-time act.

- [ ] **3. Merge to `main`.** `deploy.yml` applies the migration, redeploys the
      edge function, builds and publishes the site, then tags a release.

- [ ] **4. Verify production login.** Sign in with a seeded name. If the gate
      rejects everyone, the edge function is not reaching the database — check the
      function logs for a `config` error before touching anything else.

- [ ] **5. Delete the `ALLOWED_NAMES` secret** from the Supabase dashboard.
      Nothing reads it any more.
