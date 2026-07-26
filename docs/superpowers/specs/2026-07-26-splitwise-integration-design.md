# Splitwise integration — design

## 1. Problem

Every week, one person fronts the money to the chapati seller and the group
settles up. Today that person also opens Splitwise and types everyone's share
in by hand, reading the numbers off this app. That manual step is the one
being removed: when a week (or a batch of weeks) is settled here, the same
expense should be creatable in the group's real Splitwise group with one
click, using the numbers this app already computed and already guarantees
balance to the cent.

## 2. What this is not

- **Not a sync.** Nothing ever reads Splitwise's state back into this app.
  This app only ever *creates* and, on reopen, *deletes* one expense per
  settlement. If someone edits the pushed expense inside Splitwise afterward,
  this app never finds out and never needs to.
- **Not OAuth.** A personal Splitwise API key, held as a Supabase secret, is
  the whole auth story. No redirect flow, no per-person Splitwise
  credentials.
- **Not a general ledger sync.** Only the group's own money movement is
  represented — the `entries`/`entry_shares` invariant already guarantees the
  numbers balance, and pushing forwards those numbers as-is rather than
  recomputing them in a second language.
- **Not multi-currency, not multi-category.** One currency, one category,
  fixed for this household.
- **Not a proactive duplicate scanner.** The design accepts a small residual
  risk of a duplicate expense on an ambiguous network failure, in exchange for
  not adding an extra API round-trip to every push (see §9.4).

## 3. Vocabulary

- **Settlement** — one "Mark paid" or "Settle All" click, covering one or
  more weeks. New concept; the pushable unit.
- **Linked** — an app person whose saved Splitwise email currently resolves
  to a member of the target Splitwise group, as of the last time it was
  checked (see §4.2 for why "as of last check" and "as of push time" are
  different things).
- **Pushed** — a settlement that has a live Splitwise expense id attached.
- **Unknown** (status) — a settlement whose last push attempt got an
  ambiguous result (e.g. a timeout) — Splitwise may or may not have created
  the expense.

## 4. Decisions

### 4.1 Linking a person to Splitwise

Each row in the People sheet gets a new field: a Splitwise email. When it's
saved (added or changed), the app calls the Splitwise edge function to fetch
the live group's members and match by (trimmed, lowercased) email. A match
stores the resolved Splitwise user id on the person and shows a "linked"
indicator; no match still saves the typed email but shows "not linked" —
saving never blocks on a mismatch, since a typo or a not-yet-accepted
Splitwise invite are both a "fix it and re-save" situation, not an error.

Two app users may not link the same Splitwise email — that would let one
Splitwise identity absorb two different people's owed shares. Saving an email
already used by another row is rejected client-side, the same way adding a
duplicate name already is.

### 4.2 Freshness — stored "linked" is a UI hint, not the truth

Someone can leave the Splitwise group after being linked here. Trusting a
stored flag at push time would let a stale link silently misattribute money.
So the stored `splitwise_user_id` is read only by the People sheet's
indicator; every push re-fetches the group's current members and re-matches
emails from scratch. A person who quietly left the group is caught at push
time, not discovered later inside Splitwise.

### 4.3 An unlinked person blocks the push

If anyone holding a nonzero share in the settlement's entries doesn't
currently resolve to a group member — never linked, or linked once but no
longer a member — the whole push is refused. Splitwise requires owed shares
to sum exactly to the cost; there is no safe way to drop or reassign a real
person's share automatically, so this fails closed rather than guessing.

The Push button gives an early, client-side hint for the common case — if
anyone with a share has no saved email at all, the button is disabled with
their name shown — but the authoritative check is always the edge function's
live group-membership lookup, since only that can catch "was linked, now
isn't."

### 4.4 Pushing is a separate action from Mark Paid

Mark Paid / Settle All are unchanged: fast, local, never blocked by anything
external. A separate "Push to Splitwise" control appears once a week (or
settlement) is paid. Folding push into Mark Paid would make a core,
frequently-used local action hostage to Splitwise's availability and the
group's linking hygiene — a new dependency with a much larger blast radius
than the button it would ride on.

### 4.5 Settlement batching — one settle action, one Splitwise entry

Marking N weeks paid together (via Settle All) should produce exactly one
Splitwise expense for all of them, not one per week — matching what typing it
in by hand would produce. A single-week Mark Paid is the same thing with
N = 1. This is the reason a new `settlements` table exists at all (§5):
without persisting "these weeks were paid together," there is no way to
recover that grouping later at push time.

### 4.6 Reopening un-pays (and un-pushes) the whole settlement

A settlement is one payment event; a week inside it can't be reopened in
isolation without breaking that. Reopening any week in a settlement reopens
every week in it. If the settlement was pushed, its Splitwise expense is
deleted first — if that delete fails for a real reason (network, API error),
the reopen is refused with an error, so the two systems never silently
diverge. If Splitwise reports the expense is already gone (e.g. someone
deleted it by hand), that counts as success and the reopen proceeds — the
goal state ("no expense exists") is already true.

Weeks paid before this feature shipped have no settlement at all
(`settlement_id` is `null`). Reopening one of those falls back to exactly
today's behavior — reopen just that single week, nothing to delete. No
backfill migration is needed for old data.

### 4.7 Payer

Defaults to whoever is signed in and clicks Push (if they're linked); a
picker lets them choose someone else instead, since the person pushing isn't
always the person who actually fronted the money. The picker offers anyone
with a saved Splitwise email; the edge function verifies the chosen payer is
a live group member the same way it verifies everyone else.

### 4.8 Expense shape

- **Description**: `Roti <date range>`, where the range spans from the
  earliest settled week's Monday to the latest settled week's Sunday, in the
  same style the app already uses for a single week (e.g. `Roti Jul 6 – 19`).
- **Date**: the day the push happens, not the days the food was eaten over —
  Splitwise expense dates conventionally track the settle-up date.
- **Currency**: CAD, fixed.
- **Category**: Splitwise's Groceries category.
- **Cost / shares**: exactly the numbers this app already computed via
  `perPerson()` across the settlement's entries — the edge function forwards
  them, it does not recompute a split (see §9.2 for why).

### 4.9 Failure handling and duplicate protection

Every settlement tracks a push outcome:

- **No expense id, no status** — never successfully pushed (either never
  tried, or the last attempt failed cleanly). Push is freely retryable.
- **Expense id present** — pushed. Badge shown, button becomes "Pushed ✓."
- **Status = `unknown`, no expense id** — the last attempt's outcome
  couldn't be determined (timeout, dropped connection). The button is
  replaced with a warning ("push status unknown — check Splitwise before
  retrying") that requires an explicit extra confirmation before trying
  again. Nothing retries on its own.

A Splitwise `200 OK` with a populated `errors` object is treated as a clean
failure, not success — this is the API's documented trap.

No proactive scan of Splitwise's existing expenses runs before pushing (the
"also check for a likely duplicate" option from the design conversation was
considered and dropped) — for a small household ledger, the cost of one more
API call on every push wasn't worth it against an already-rare failure mode
that degrades to "delete the extra expense by hand" in the worst case.

### 4.10 Who can push

Anyone with a signed-in session can push — the same trust boundary every
other write in this app already uses (there is no admin role anywhere, and
the light gate is a social convention layered on top of Supabase's own
"authenticated" check, not a stronger guarantee). The edge function itself
still requires a real authenticated Supabase session and rejects anonymous
requests with none — that's the actual gate, and it's the same one RLS
already applies to every table in this project.

### 4.11 Audit log

Two new log actions — pushing and the reopen-triggered removal — appear in
the existing Log tab exactly like `paid`/`reopen` do today, including when
they affect several weeks in one settlement (one log row per affected week,
same as Settle All already produces several `paid` rows for one click).

## 5. Data model

### 5.1 New: `settlements`

```sql
create table public.settlements (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  actor                   text not null,        -- who clicked Mark paid / Settle All
  device_id               text,
  -- restrict, not cascade: a settlement is a real record of who fronted
  -- money, and the app's existing rule ("a person with history cannot be
  -- deleted") should hold for this history the same way it holds for
  -- entry_shares.
  splitwise_payer_user_id uuid references public.users(id) on delete restrict,
  splitwise_expense_id    text,                 -- set once the push succeeds
  splitwise_status        text check (splitwise_status in ('unknown')),
  splitwise_pushed_at     timestamptz
);
```

One row per Mark Paid / Settle All click. `splitwise_expense_id is not null`
is the definition of "pushed" — there's no separate boolean to keep in sync
with it. `splitwise_status = 'unknown'` with no expense id means the last
push attempt was ambiguous. Settlement rows are never deleted, even once
every week inside them is reopened — they're a historical record of a
payment event, the same way `logs` never deletes rows.

### 5.2 Changed: `weeks`

```sql
alter table public.weeks
  add column settlement_id uuid references public.settlements(id) on delete restrict;
```

Nullable. Set when a week is included in a settlement; cleared back to `null`
when that settlement is reopened. `null` also describes every week paid
before this feature existed. `restrict` is academic in practice — nothing in
this design ever deletes a settlement row — but it matches this schema's
existing convention of stating every foreign key's delete behavior
explicitly rather than leaning on Postgres's default.

### 5.3 Changed: `users`

```sql
alter table public.users add column splitwise_email    text;
alter table public.users add column splitwise_user_id  text;
```

`splitwise_email` is what's typed in the People sheet. `splitwise_user_id` is
the resolved id from the last successful link check — read only by the
People sheet's indicator, never trusted at push time (§4.2).

### 5.4 RLS, grants, realtime

`settlements` gets the same policy every other table already has:

```sql
alter table public.settlements enable row level security;
create policy "authed all - settlements" on public.settlements
  for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.settlements to authenticated;
```

`settlements` is added to the `supabase_realtime` publication and to
`subscribeChanges()`, the same way `entry_shares` was added when it shipped.

## 6. Invariants

- Every `weeks.settlement_id` either points at a real settlement or is
  `null`. Only `createSettlement` (§7.2) and the reopen path (§7.4) ever
  write this column.
- `sum(people[].amount) === totalCost` for whatever is sent to the edge
  function — this is not new arithmetic, it's the same
  `entries.amount = sum(entry_shares.amount)` invariant §6.1 of the original
  design already enforces, just carried through unchanged rather than
  recomputed.
- A settlement's `splitwise_expense_id`, once set, is only ever cleared by
  the reopen path, and only after Splitwise itself confirms (or already
  agrees) the expense is gone.

## 7. Write path

### 7.1 Linking

Client calls the edge function with `{action: "link", email}`. On a match, it
writes `splitwise_email` and `splitwise_user_id` to the `users` row directly
(same pattern as every other People-sheet write — the edge function itself
never touches the database). On no match, it writes just the email, leaving
`splitwise_user_id` null.

### 7.2 Settling (Mark Paid / Settle All)

Both actions now go through one function, `createSettlement(weekIds, actor,
device)`:

1. Insert one `settlements` row.
2. Update every week in `weekIds`: `paid = true`, `paid_at = <the
   settlement's created_at>`, `settlement_id = <the new id>`.
3. Log a `paid` row per week, as today.

A single-week Mark Paid is `createSettlement([weekId], ...)` — there is no
separate single-week code path anymore.

### 7.3 Pushing

1. Client gathers every entry across the settlement's weeks (already loaded,
   same data `SettleSummary` already renders), computes `perPerson()`, and
   confirms client-side that everyone with a nonzero share has a saved email
   (§4.3's early hint).
2. Confirm dialog shows the combined breakdown (`SettleSummary`, reused
   as-is) plus a payer picker defaulting to the current user.
3. On confirm, calls the edge function with `{action: "push", payerEmail,
   people: [{name, email, qty, amount}], totalCost, description, date}`.
4. On `{ok: true, expense_id}`: write `splitwise_expense_id`,
   `splitwise_payer_user_id`, `splitwise_pushed_at` on the settlement; clear
   any prior `splitwise_status`. Log one `splitwise_push` row per week in the
   settlement.
5. On a clean failure: show the error, write nothing (settlement stays
   retryable).
6. On an ambiguous failure (timeout, network drop mid-request): write
   `splitwise_status = 'unknown'`.

### 7.4 Reopening

`reopenWeek(weekId)` first looks up that week's `settlement_id`.

- **No settlement** (pre-feature data): behaves exactly as today —
  `paid = false`, `paid_at = null` on that one week, one `reopen` log row.
- **Has a settlement, not pushed**: same as above, but applied to every week
  sharing that `settlement_id`, and `settlement_id` cleared on all of them.
- **Has a settlement, pushed**: call the edge function
  `{action: "delete", expense_id}` first.
  - Splitwise confirms deleted (or reports it's already gone) → proceed as
    above, plus one `splitwise_unpush` log row per week in the settlement.
  - Splitwise reports a real error → abort. Nothing is reopened. The week
    stays exactly as it was, with an error shown.

The settlement row's own `splitwise_expense_id`/`status`/`pushed_at` are left
untouched by a reopen — only the weeks' `settlement_id` is cleared. The
settlement becomes unreachable from the current week list (§8 only ever
reaches a settlement via a week that still points at it), so nothing reads
those now-stale fields again; they simply remain as an accurate record that
this settlement was pushed as that expense, once, before being reopened.

## 8. Read path

A week's push state is entirely derived from its settlement (looked up by
`settlement_id`, already loaded alongside `weeks` since both are small
tables fetched in full):

- `settlement_id === null` → no push controls (pre-feature week) beyond the
  existing bare "Reopen."
- `settlement_id` set, `splitwise_expense_id === null`,
  `splitwise_status !== 'unknown'` → "Push to Splitwise" button.
- `splitwise_expense_id` set → "Pushed ✓" badge, linking to
  `https://secure.splitwise.com/expenses/<id>`.
- `splitwise_status === 'unknown'` → warning control requiring explicit
  re-confirmation before allowing another push attempt.

Every week sharing a settlement shows identical state, since it's the same
underlying row. Pushing or reopening from any one of them acts on all of
them — no new grouping UI is introduced; the existing WeekCard-per-week
layout in History is unchanged.

## 9. The Splitwise edge function

### 9.1 Shape

One new function, `supabase/functions/splitwise/index.ts`. Requires a real
authenticated Supabase session on every request — rejects anonymous/missing
sessions the same way every RLS-protected table write already does; the
exact mechanism (`@supabase/server`'s `withSupabase` helper, configured for a
real session rather than `validate-access`'s pre-session `["publishable"]`
mode) is confirmed against that library during implementation, but the
requirement itself — no session, no response — is fixed.

It needs no Supabase database access at all: the client already holds
everyone's name, email, qty and amount in memory, and sends exactly what's
needed in the request body. The function's only job is talking to the
Splitwise API using two secrets it alone holds:

- `SPLITWISE_API_KEY`
- `SPLITWISE_GROUP_ID`

Three actions:

| action   | request                                                                                 | response                                                    |
|----------|------------------------------------------------------------------------------------------|--------------------------------------------------------------|
| `link`   | `{ email }`                                                                               | `{ linked: true, splitwise_user_id, name }` or `{ linked: false }` |
| `push`   | `{ payerEmail, people: [{ name, email, qty, amount }], totalCost, description, date }`    | `{ ok: true, expense_id }` or `{ ok: false, error, detail }` |
| `delete` | `{ expense_id }`                                                                          | `{ ok: true }` or `{ ok: false, error }`                     |

### 9.2 Why the edge function doesn't recompute the split

The client already computed `people[].amount` via the exact same
`perPerson()`/`buildShares()` logic that produces the numbers shown
everywhere else in the app, and the app's own invariants (§6 of the original
design) already guarantee those amounts sum to the entry totals. Redoing that
math in Deno would mean maintaining the same rounding rules in two languages
with no shared source (Deno can't import `src/lib`, as `validate-access`'s
own comment notes) — a second place for the two to quietly drift. Instead the
edge function does one cheap sanity check, `sum(people[].amount) ===
totalCost`, and forwards the numbers as-is onto Splitwise's
`users__{i}__owed_share` fields.

### 9.3 `link` and `push` share one lookup

Both actions need "fetch the group's current members and match emails" —
implemented once, used from both branches.

### 9.4 The 200-OK trap

Splitwise can return HTTP 200 with a populated `errors` object on
`create_expense`. The function treats that the same as a transport-level
failure: `{ ok: false, ... }`, never `{ ok: true }`.

## 10. UI

- **People sheet**: one new input per row (Splitwise email), plus a small
  linked/not-linked indicator. Duplicate-email save is rejected client-side
  before the link check even runs, the same way a duplicate name already is
  in `handleAdd`.
- **WeekCard**: a paid week gains the push button/badge described in §8,
  placed where the existing bare "Reopen" link is today. No change to how
  weeks are listed or grouped.
- **New confirm dialog** for pushing: reuses `SettleSummary` for the
  breakdown, adds a payer `<select>` (linked people only, defaulting to the
  current user).
- **LogView / logtext.ts**: two new `LogAction`s (`splitwise_push`,
  `splitwise_unpush`), each composed the same way `describeAdd`/`describeEdit`
  already compose their `detail` text at write time (e.g. `Roti Jul 6 – 19 ·
  $42.00 · paid by bhavin`).
- **src/config.ts**: two new constants, `SPLITWISE_CURRENCY = "CAD"` and the
  Splitwise Groceries category id, alongside the existing `CURRENCY` and
  `DEFAULT_PRICE` — sent as part of the push request rather than hardcoded in
  the edge function, keeping every money-adjacent constant in the one file
  that already holds them.

## 11. Testing

- **Pure logic in `src/lib`**, covered by vitest same as everything else:
  the settlement date-range label builder (§4.8), the mapping from
  `PersonTotal[]` to the edge function's `people[]` shape, and email
  normalization/matching.
- **The edge function itself** has no vitest coverage, consistent with
  `validate-access` having none today — it's Deno, not part of the `src/`
  tree the test config targets.
- **Manual/integration testing** happens against a disposable Splitwise
  group, referenced purely by swapping the `SPLITWISE_GROUP_ID` (and
  optionally `SPLITWISE_API_KEY`, if a fully separate test account is
  preferred) secret value — no test-mode branching in the code. This pairs
  naturally with the local Supabase project already used for development
  (separate from the production project), so local testing never touches
  production data on either side of the integration.

## 12. Migration and rollout

One migration file, additive only (new table, new nullable columns, no
drops) — clears the CI destructive-SQL guard with no `-- allow-destructive`
marker needed.

Order, mirroring how `deploy.yml` already sequences things:

1. Migration applies (adds `settlements`, `weeks.settlement_id`,
   `users.splitwise_email`/`splitwise_user_id`, RLS, realtime).
2. New deploy step added for the `splitwise` function, mirroring
   `validate-access`'s.
3. Frontend builds and deploys.
4. **Manually, once**: `supabase secrets set SPLITWISE_API_KEY=...
   SPLITWISE_GROUP_ID=...` against the production project — using a freshly
   rotated key, since the one shared earlier in this conversation should be
   treated as burned.
5. Link everyone's Splitwise email in the People sheet.
6. First real push — worth trying on a single small week before trusting it
   with a multi-week settlement.

No backfill is needed for weeks paid before this ships — §4.6 covers why
`settlement_id = null` on old data degrades gracefully rather than needing
migration-time synthetic settlement rows.

## 13. Risks and accepted trade-offs

- **Anyone signed in can push.** Same trust boundary as every other action in
  this app; not a new weakness introduced by this feature.
- **No proactive duplicate scan.** An ambiguous timeout can in principle
  produce a duplicate Splitwise expense; recovery is deleting it by hand,
  same as it would be if this were still done manually.
- **Settlement rows accumulate forever**, including for settlements that
  were fully reopened and never re-pushed. Harmless — same append-only
  posture as `logs`.
- **The Groceries category id** is treated as a fixed constant sourced from
  Splitwise's category list; it should be confirmed against the live API
  during implementation rather than assumed permanently stable.
- **CAD is hardcoded.** Fine for a single-household, single-currency ledger;
  would need revisiting if that ever stops being true.
- **A person can be "linked" in the People sheet and still fail at push
  time** if they left the group in between (§4.2, by design) — this will
  read as mildly surprising the first time it happens, worth a clear error
  message naming exactly who failed and why.
- **`canDeletePerson`/`hasShares` aren't updated to check settlement
  payership.** The `on delete restrict` on `splitwise_payer_user_id` (§5.1)
  means the database will refuse to delete someone who was ever recorded as
  a payer, but the People sheet's own pre-check (§4.1 of the original
  design) doesn't know that yet, so the failure surfaces as the same generic
  "Could not save that" message the project already accepts for other
  collapsed Postgres failures (per the per-person-splits follow-ups doc) —
  not a new class of problem, just one more case falling into an
  already-accepted one.
