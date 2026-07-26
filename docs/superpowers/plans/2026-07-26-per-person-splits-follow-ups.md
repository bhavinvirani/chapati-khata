# Known follow-ups after per-person splits

Date: 2026-07-26
Source: the eleven per-task reviews and the final whole-branch review of
`feat/per-person-splits`.

Everything here was **found, judged, and deliberately left**. Each was triaged as
able to stand rather than overlooked, so nothing below needs re-deriving — but
nothing below is fictional either. Items are grouped by what fixing them buys.

## Worth doing

### Put the lockout invariant in the database

The two guardrails — you cannot clear your own `can_login`, you cannot clear the
last remaining one — are client-side check-then-act, and RLS grants every
authenticated session `update` and `delete` on `users`. So devtools bypasses them
entirely, and two people revoking each other near-simultaneously can both pass
their own check and land both writes, leaving zero logins.

Design §4.6 states the second guardrail as a rule, and under concurrency it is
not one. A statement trigger on `public.users` raising when
`count(*) filter (where can_login) = 0` after the statement would make it a real
invariant — for concurrent writes, direct API calls, and whatever code path
someone forgets to guard next time. It is the only fix that survives being
forgotten.

Recovery today is the Supabase SQL editor, which §14 accepts.

### Rename `entries` to `unpaidEntries`

`useKhataData` exposes `entries` meaning "unpaid weeks only" while it reads like
"the entries". That single ambiguity produced three separate defects, one of
which shipped a backup missing every settled week and survived a fix attempt.
Renaming makes each remaining misuse a type error instead of a silent omission.

### Drop the eslint suppression in AddForm

`AddForm`'s prefill effect carries
`// eslint-disable-next-line react-hooks/set-state-in-effect`, against
`eslint.config.js`'s own "Backlog verified at zero — keep it that way".

A reviewer verified the alternative rather than guessing at one: hold `rows` as
`Alloc | null` where `null` means "untouched for this date", derive the view as
`rows ?? prefill` with `prefill` in a `useMemo`, and reset to `null` from the
date input's `onChange`. That shape lints clean with no suppression and honours
both constraints the ref currently serves — a typed allocation is concrete state
no refresh can overwrite, and nothing primes before data loads. React's
render-time "adjust state on prop change" pattern is _not_ an option here; it
trips `react-hooks/set-state-in-render`, also an error in this plugin's
recommended config.

Deferred because it reworks the one mechanism the branch had just validated.

### Debounce the realtime reload

Every add now fires a `postgres_changes` event per share row, plus entries, plus
logs — and each one triggers an unthrottled full `load()` of 3–4 queries. An
eight-person add produces roughly ten reloads per device. Harmless at this scale
and new to this feature. A 250 ms debounce inside `subscribeChanges`' callback
removes it.

## Small and self-contained

- **Rate display loses precision.** `money(e.rate)` renders a stored `0.1235` as
  `$0.12`, and `sanitizeQty` accepts more decimals than `numeric(10,4)` stores.
  No invariant breaks — nothing recomputes money from a rate — but the displayed
  rate stops explaining the displayed amount. Cap the rate in `sanitizeQty` and
  give rates their own formatter.
- **Stats has no repair signal.** A broken add makes the per-person lists
  disagree with the group `spent` tile, with nothing on screen saying why.
  WeekCard warns; StatsSheet does not.
- **`db.nameCanLogin` does not normalise its argument** though `addPerson` does,
  and `addPerson`'s own comment says the boundary re-checks rather than trusting
  its caller. Both current callers normalise first, so this is a latent trap for
  a third.
- **`useKhataData`'s week sort comparator never returns 0.** Week starts are
  unique so no tie is reachable, but it is the last instance of a class fixed
  four times on this branch.
- **`paid` is shadowed inside `exportJSON`** — a `WeekView[]` in the outer scope,
  an `Entry[]` inside. Correct today; a same-name/different-type collision in one
  file. No `no-shadow` rule is configured to catch it.
- **README's Backups paragraph and `src/` file map are stale** — the paragraph
  omits `users` and does not mention that paid weeks are now included; the map
  predates `lib/people.ts`, `lib/split.ts`, `lib/aggregate.ts`,
  `PeopleSheet.tsx`, `SplitEditor.tsx`, `PaidHistory.tsx` and `StatsSheet.tsx`.

## Accepted limits, recorded so they are not rediscovered as bugs

- **One undetectable write outcome remains.** If the prune step of an edit fails
  while the kept people's aggregate qty happens to equal the old total, the stale
  row for a dropped person goes unflagged — and at a clean rate its amount
  coincides too. No client-side ordering fixes this; only a transactional RPC
  would, which §7 explicitly traded away for keeping the logic in TypeScript.
- **`setPersonFlag` and `deletePerson` do not check that a row matched.** An
  update against a row another device already removed affects zero rows, returns
  no error, and reports success. The realtime refresh limits the blast radius.
- **The confirm card's `hasShares` is not re-fetched** at click time, only
  `can_login` is re-checked. Backstopped by `on delete restrict`.
- **`run()` collapses distinguishable Postgres failures** — a unique-name race
  and an `on delete restrict` refusal both read as "Check your connection".
- **UI edge cases:** the single-slot `primedFor` ref discards an allocation when
  you revisit a date; `SplitEditor` cannot render a deliberate `0` and swallows a
  typed leading zero; `EditSheet` appends deactivated share-holders in raw order
  while the head of the list is sorted; a rate-only edit logs as a bare
  "edited {day}" because `logs` has no rate columns.
- **`users.name` is trusted lowercase by convention**, not by a `check`
  constraint. The app is the only writer and now normalises at both the boundary
  and the UI, including stripping format characters.
- **A session saved before this branch** whose stored name contains a format
  character will be signed out once, since `restoreUser` now normalises. Fails
  closed.
- **Test-comment inaccuracies:** `aggregate.test.ts` cites a `$9.81` figure that
  belongs to the design's larger example rather than that test's own numbers; a
  `split.test.ts` case named for remainder distribution uses `45 % 3 == 0`; the
  float-noise test does not discriminate its epsilon because `round2` collapses
  the noise first. The assertions are all correct; the names and comments
  overpromise.
