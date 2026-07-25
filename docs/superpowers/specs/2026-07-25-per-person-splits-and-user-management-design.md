# Per-person splits and user management — design

Date: 2026-07-25
Status: approved, ready for implementation planning

## 1. Problem

Chapati Khata records the group's tab with the roti provider: one entry per day,
one group total, settled weekly. It has no concept of an individual person
beyond the name typed at the gate and the `actor` breadcrumb on log rows.

Two things are missing:

1. **Who ate what.** One person fronts the money to the shop and later enters
   everyone's share into Splitwise. Today that attribution lives entirely in
   their head; the app only knows the group total.
2. **Managing the group from inside the app.** The login allowlist is a JSON
   file in the repo, so adding a housemate needs a commit, a push and a CI run.

This design adds a per-person breakdown to every purchase and moves the
allowlist into the database, without changing what the app is: a shared record
of the group's tab with the shop.

## 2. What this is not

The per-person breakdown is **a record of consumption, not a settlement
ledger.** Person-to-person reimbursement happens in Splitwise and this app never
tracks who paid whom inside the group. Concretely, that rules out:

- per-person payment tracking or partial settlement
- per-person balances in the "who owes me" sense
- any notion of a payer, since the same person fronts every payment

Settlement with the roti provider stays exactly as it is today: one weekly
`paid` flag for the whole group, one action.

## 3. Vocabulary

The word "entry" changes meaning, so it is pinned down here.

| Term       | Meaning                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add**    | One purchase run: a date, a total qty, one rate, one complete per-person allocation. The unit of entry, editing and deletion. Stored as a row in `entries`. |
| **Day**    | A display grouping of that date's adds. No longer a stored row.                                                                                             |
| **Week**   | Monday-anchored. The settlement unit with the roti provider. Unchanged.                                                                                     |
| **Share**  | One person's qty and money within one add. Stored as a row in `entry_shares`.                                                                               |
| **Person** | A row in `users`, carrying two independent switches.                                                                                                        |

## 4. Decisions

Each of these was decided explicitly during requirements gathering. They are
stated as rules the implementation must satisfy.

### 4.1 Entry flow

**The day's total is authoritative and is allocated downward.** You type the
total, then distribute it across people. A live readout shows how much is left
to allocate, and the add cannot be saved until that reads exactly zero.

There is no partial or draft state. If the split is not yet known, nothing is
recorded. This was chosen with the 8am-purchase / 4pm-claim case explicitly on
the table.

### 4.2 One row per add

A second purchase on the same day is **its own row**, with its own rate and its
own complete allocation. There are no per-person deltas and no blending.

This requires dropping the `UNIQUE` constraint on `entries.day`. It also
removes the read-modify-write race in the current `addToday`, where two people
adding at once can overwrite each other's qty — adds become pure inserts.

### 4.3 Pricing

**One rate per add, uniform across everyone in that add.** Several adds on the
same day may each carry a different rate. A person's effective rate differs from
another's only as a consequence of which runs they were in.

Rate becomes a stored column. The current behaviour — blending a day into a
single average rate — is not carried forward: once a day is split, a blended
rate silently misattributes money between people, subsidising whoever bought at
the expensive rate at the expense of whoever bought at the cheap one.

### 4.4 People

Every person carries **two independent switches**:

- `in_split` — appears in the split composer when adding
- `can_login` — passes the gate

All four combinations are meaningful. The one that motivated two switches over
a three-state status is _in the split but no app access_ — someone who eats roti
but never installs the app.

Any signed-in user can add people and flip either switch. There is no admin
role, consistent with the app's existing trust model.

### 4.5 Removal and history

**History is immutable. Nothing that happens to a person ever reaches backwards
into recorded entries.**

Removing a person means turning both switches off. Their row and every share
they hold stay exactly as they are, forever.

The single exception: a person holding **zero** shares may be permanently
deleted, so a mistyped name does not become permanent clutter. This is enforced
by the database (`on delete restrict`), not merely checked by the app.

### 4.6 Login allowlist

The `users` table becomes the **only** allowlist. `allowed-names.json`, the
`ALLOWED_NAMES` Supabase secret, the CI sync step and `config.ts`'s exported
array are all removed.

Because any user can revoke any other user's access, two guardrails apply:

- you cannot clear your own `can_login`
- you cannot clear the last remaining `can_login`

### 4.7 Split composer defaults

Boxes open **prefilled from the most recent add**, because the group's pattern
usually repeats. "Most recent" means the highest `created_at` across all adds,
not the previous calendar day — a gap in ordering should not empty the form.
Two one-tap fills are available: **Even split** and **Same as last**, plus
**Clear**.

Prefill applies only when the selected date has **no adds yet**. A second add on
the same day starts blank — the morning's 45-across-seven is the wrong shape for
an evening 20-across-two, and inheriting it means clearing five rows by hand.

### 4.8 Off-split people

The composer lists only people with `in_split` on. A person who is off the
split cannot receive a share; to include them, turn their split switch back on.
There is no per-add escape hatch. The cost is two extra taps on a rare day; the
benefit is that "active" keeps a single unambiguous meaning.

### 4.9 Existing data

**Fresh start.** The database is wiped before this ships, so there is no legacy
data, no backfill, and no conditional handling of unsplit rows. The
total-equals-shares invariant holds unconditionally from the first row.

### 4.10 Group size

The split composer handles **any number of people generically**. Roughly eight
is what this group happens to run; nothing is tuned or capped for it.

## 5. Data model

### 5.1 New: `users`

```sql
create table public.users (
  id         uuid    primary key default gen_random_uuid(),
  name       text    not null unique,          -- stored lowercase, trimmed
  in_split   boolean not null default true,
  can_login  boolean not null default true,
  created_at timestamptz not null default now()
);
```

Names are lowercased and trimmed on write, matching how the gate already
normalises input. Composer rows are ordered by `created_at`, so adding a person
appends to the bottom rather than reshuffling established row positions.

There is no rename in this round. Names are fixed once created; a typo on a
person with no shares is fixed by deleting and re-adding.

### 5.2 New: `entry_shares`

```sql
create table public.entry_shares (
  entry_id uuid    not null references public.entries(id) on delete cascade,
  user_id  uuid    not null references public.users(id)   on delete restrict,
  qty      integer not null check (qty > 0),
  amount   numeric(10,2) not null,
  primary key (entry_id, user_id)
);
create index entry_shares_user_idx on public.entry_shares(user_id);
```

`check (qty > 0)` means a person who took nothing has **no row**, rather than a
zero row. "Participants in this add" is exactly the set of rows present.

The two foreign keys carry the design's guarantees:

- `on delete cascade` from `entries` — deleting an add removes its shares.
- `on delete restrict` from `users` — a person holding shares is physically
  undeletable. Section 4.5's rule is a database property, not an app check.

### 5.3 Changed: `entries`

- **add** `rate numeric(10,4) not null check (rate > 0)`
- **drop** the `entries_day_key` unique constraint on `day`
- **add** an index on `day` (rows are now grouped by day for display)
- `qty` and `amount` remain, holding the add's total — see the invariant below
- `note` keeps its meaning, but the automatic rate-tag enrichment in the current
  `addToday` is removed as redundant now that rate is a real column

### 5.4 Changed: `logs`

- **add** `target text` — the name of the person a people-action refers to.
  Existing columns describe entries and weeks and have nowhere to put it.

`logs.action` is already free text in Postgres, so new action strings need no
migration. The TypeScript `LogAction` union and `LogView`'s renderer both need
extending:

| action           | renders as                       |
| ---------------- | -------------------------------- |
| `user_add`       | added \<target\>                 |
| `user_delete`    | deleted \<target\>               |
| `user_split_on`  | put \<target\> in the split      |
| `user_split_off` | took \<target\> out of the split |
| `user_login_on`  | gave \<target\> access           |
| `user_login_off` | revoked \<target\>'s access      |

### 5.5 Unchanged

`weeks` is untouched. Weekly group settlement keeps its exact current
semantics, including the rule that a paid week is locked against adds and edits
until reopened.

## 6. Invariants and money

### 6.1 The invariant

> For every add: `entries.qty` equals the sum of its shares' `qty`, and
> `entries.amount` equals the sum of its shares' `amount`.

### 6.2 Rounding

Each share's amount is `round2(share.qty × rate)`. **The add's amount is the sum
of its share amounts** — not `round2(total_qty × rate)`.

At a rate that doesn't divide cleanly these two differ by a cent or two. Summing
the shares puts that discrepancy on the group total, where it is harmless,
rather than on the split, where it would make the per-person figures fail to
reconcile. Shares always add up exactly.

### 6.3 Even split remainder

`Even split` gives everyone `floor(total / n)` and distributes the remainder as
one extra each to the first `r` people in composer order. Deterministic, so it
is directly unit-testable.

## 7. Write path

Writes stay in TypeScript in `src/lib/db.ts` as plain table operations. There
are no database functions and no RPCs. `supabase-js` has no client-side
transactions, so this is a deliberate trade: readable, testable logic in one
file, at the cost of a reachable inconsistent state.

### 7.1 Add

1. `ensureWeek(weekId)`
2. insert the `entries` row, returning its id
3. insert **all shares in a single batch call**
4. insert the log row

Step 3 being one statement means Postgres commits every share or none. The only
reachable bad state is therefore _an entry with no shares at all_.

If step 3 fails, the app immediately attempts to delete the entry created in
step 2. If that cleanup also fails, the orphan survives and is handled by §7.3.

### 7.2 Edit

Editing an add replaces its allocation. Ordering rule:

> **Never delete existing shares before their replacements are written.**

So: upsert the new share set, then delete shares for that entry whose `user_id`
is not in the new set, then update the `entries` row. No ordering avoids a
transient mismatch without a transaction; this ordering makes the transient
state an over-allocation, which is detectable and repairable, rather than a loss
of attribution.

### 7.3 The repair state

An add whose shares are missing, or whose share quantities do not sum to its
`qty`, renders as **⚠ needs repair** with two actions:

- **Finish split** — opens the editor with the total locked
- **Discard** — deletes the add

This check runs over already-loaded data; it needs no extra query. It is the
same half-split state rejected as a feature in §4.1, present only as an error
that cannot be authored deliberately.

## 8. Read path

`loadActive` additionally fetches **all** users (tiny, and the composer needs
them) and embeds shares through PostgREST:

```ts
.select("*, entry_shares(*)")
```

`loadPaidEntries` gains the same embed. `users` and `entry_shares` are added to
the `supabase_realtime` publication and to `subscribeChanges`, so a split
entered on one phone appears on another.

`PeopleSheet` additionally runs one aggregate query counting shares per user, to
decide whether the permanent-delete action is offered. That count cannot be
derived client-side, since shares for paid weeks are only loaded on demand.

## 9. Authentication

The edge function stops reading the `ALLOWED_NAMES` environment variable and
instead queries the database for a matching name with `can_login` set. It needs
the **service-role key** rather than the publishable one, because the gate runs
before there is a session to authorise with.

Client-side:

- `src/config.ts` drops `ALLOWED_NAMES`; `DEFAULT_PRICE` and `CURRENCY` stay
- `allowed-names.json` is deleted
- `useAuth.restoreUser` validates a restored name against the users list rather
  than a bundled array
- the local-dev gate path in `App.tsx` checks the name against `users` directly
  instead of the bundled array; `VITE_ENTRY_CODE` behaviour is unchanged

CI: the "Sync ALLOWED_NAMES to Supabase secrets" step is removed from
`deploy.yml`. The `ALLOWED_NAMES` secret is deleted manually from the Supabase
dashboard afterwards. `ENTRY_CODE` is untouched.

### 9.1 Guardrails

Two pure predicates, unit-testable, enforced in the app:

- `canRevokeLogin(target, actor, users)` — false when the target is the actor,
  and false when the target is the only user with `can_login`
- `canDelete(user, shareCount)` — true only when `shareCount` is zero; the
  database enforces this independently via `on delete restrict`, so the app
  check exists to produce a good message rather than a foreign-key error

## 10. UI

### 10.1 AddForm → split composer

Date picker unchanged. The total box keeps the existing `45` and `45x0.75`
shorthand, so `parseQty` and `sanitizeQty` survive as they are — but the parsed
rate is now stored on the row instead of being blended away.

Below it, one row per `in_split` person, prefilled per §4.7, with **Even
split**, **Same as last** and **Clear**. A live "N left to allocate" readout
sits above the button, and **Add** is disabled unless it reads zero.

### 10.2 WeekCard

Rows group by day. Each day shows its date and combined total; beneath it, one
sub-row per add showing `qty @ rate` and amount. An add's per-person split is
**collapsed by default** and expands on tap — with eight people per add, showing
every split inline would bury the week. Editing is a separate control on the
add row, so expanding to look and tapping to change are never confused.

Each week card also shows a **per-person subtotal for that week**. This is the
same data one aggregation up, needs no new screen, and is what makes manual
Splitwise entry workable — see §12.

### 10.3 EditSheet

Edits one add: total, rate, note and allocation, under the same allocate-down
gate as the composer. Delete removes the add and cascades its shares. The
current blended-rate preservation logic in `editEntry` is removed — the rate is
now stored and edited directly.

### 10.4 New: PeopleSheet

A flat list in composer order, one row per person, each row carrying both
toggles — split and login — so all four states are visible and reachable
without navigating between groups. Supports adding a person, flipping either
switch, and permanently deleting a person with no shares.

Destructive actions route through the existing `ConfirmDialog`. Guardrail
violations disable the control with an explanation rather than failing on tap.

### 10.5 StatsSheet

Keeps its group figures and gains a per-person view: each person's chapatis,
spend and effective rate for the selected month, plus a lifetime total.

### 10.6 LogView

Renders the six new action strings from §5.4, with a colour class for people
actions alongside the existing ones.

### 10.7 Export

`exportJSON` includes `users` and each entry's shares. Without this it would
silently export a backup missing the entire feature.

## 11. Testing

`vitest` is configured with `passWithNoTests` and the repo currently has no
tests. This feature ships the first ones. All of the following are pure
functions in `src/lib/`, requiring no database:

- allocation validation — remainder computation, the zero-remainder gate,
  over-allocation
- even-split distribution including remainder placement
- money rounding, and that share amounts sum to the stored add amount
- per-week and per-month per-person aggregation
- `canRevokeLogin` and `canDelete`
- the repair-state predicate over loaded entries

## 12. Out of scope

Decided against, or deferred, with the reason recorded so it is not re-litigated:

| Item                                    | Why                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Per-person settlement / partial payment | Contradicts week-level settlement; person-to-person lives in Splitwise                                                                    |
| Payer field                             | The same person fronts every payment                                                                                                      |
| Date-range per-person summary screen    | Deferred; the Splitwise handoff stays manual for now. Consequence: a bi-weekly entry means reading two week cards and adding them by hand |
| Copy-to-clipboard for Splitwise         | Not wanted                                                                                                                                |
| Per-person breakdown on the To pay card | Not wanted                                                                                                                                |
| Unassigned / draft remainder            | Explicitly rejected in favour of the hard gate                                                                                            |
| Renaming a person                       | Not requested; delete-and-re-add covers the zero-share case                                                                               |
| Retroactive effects of removal          | History is immutable by design                                                                                                            |
| Legacy backfill                         | No legacy data exists after the wipe                                                                                                      |

## 13. Migration and rollout

### 13.1 Wipe (manual, irreversible)

Performed in the Supabase SQL editor **before** deploying, not as a migration:

```sql
delete from public.weeks;   -- cascades entries
delete from public.logs;
```

Kept manual for two reasons: as a migration it would be a `delete from`, which
`ci.yml`'s guard blocks without an `-- allow-destructive` marker; and it would
sit in migration history permanently, re-validated on every CI run, describing a
one-time act.

### 13.2 Migration

One migration, applied automatically on merge by `deploy.yml`:

1. create `users`, seeded with both switches on from the seven names currently
   in `allowed-names.json`. The names are written literally into the migration
   — SQL cannot read a repo file, and the file is deleted in this same change
2. create `entry_shares`
3. `alter table entries add column rate`
4. `alter table entries drop constraint entries_day_key`
5. add the `day` index
6. `alter table logs add column target text`
7. RLS policies and `authenticated` grants for both new tables, following the
   existing pattern — the schema's own comment notes that RLS without the
   table-level grant fails with "permission denied"
8. add both new tables to the `supabase_realtime` publication, using the same
   guarded `do $$ ... $$` block the schema already uses, since
   `alter publication ... add table` has no `if not exists` form

The `ci.yml` and `deploy.yml` destructive-statement guard matches `drop table`,
`drop column`, `drop schema`, `drop extension`, `truncate`, `delete from` and
column type changes. `alter table ... drop constraint` matches none of these, so
**no `-- allow-destructive` marker is required** for step 4.

`supabase/schema.sql` is rewritten to describe the final state, keeping its role
as the readable single-file description of the database.

### 13.3 Order of operations

1. Merge the schema migration and app changes together — the app cannot work
   against the old schema, and `deploy.yml` applies migrations before the
   frontend build in the same run.
2. Wipe the data immediately before that merge.
3. Delete the `ALLOWED_NAMES` Supabase secret afterwards.

## 14. Risks and accepted trade-offs

**The app has no real per-person authentication.** Every browser shares one
anonymous Supabase session, RLS grants any authenticated session full access to
every table, and the name at the gate is self-declared behind a shared code.
Anyone who can log in can log in as anyone else, and can edit anyone's shares.
The per-person records are therefore an honour-system bookkeeping aid among
friends, not an authenticated claim. This is unchanged by this design and
consistent with the existing "light gate, not fortress-grade, by design" stance
— but it is worth stating plainly now that data is attributed to individuals.

**Any user can lock out any other user.** Mitigated by the two guardrails in
§4.6, not eliminated. Recovery from a bad state is through the Supabase SQL
editor.

**The inconsistent-write window is real.** Chosen deliberately over database
functions in exchange for keeping all logic in TypeScript. Mitigated by batching
share inserts, by best-effort cleanup, by the never-delete-before-replace
ordering rule, and by the repair UI.

**Editing is not concurrency-safe.** Two people editing the same add at once can
still produce a last-write-wins result. This is no worse than today, and adds
themselves are now safe where they previously raced.
