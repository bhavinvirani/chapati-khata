# Interactive config script — design

## 1. Problem

Configuring this app for a group means touching four unrelated places, in a
specific order, with no single view of what's already done:

| Where                          | What lives there                                                                                                       | How it's changed today                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `src/config.ts`                | `DEFAULT_PRICE`, `CURRENCY`, `SPLITWISE_CURRENCY`, `SPLITWISE_CATEGORY_NAME`                                           | edit the file, commit, push, wait for the deploy |
| `.env` (gitignored)            | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_ENTRY_CODE`                                                       | edit the file, restart the dev server            |
| Supabase edge-function secrets | `ENTRY_CODE`, `SPLITWISE_API_KEY`, `SPLITWISE_GROUP_ID`                                                                | `supabase secrets set …`                         |
| GitHub secrets                 | `SUPABASE_URL`, `SUPABASE_ANON_KEY` (repo); `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` (`production` environment) | GitHub UI or `gh secret set`                     |

Three values live in more than one of those places at once, and the README
(Steps 3–4, plus the Splitwise section) walks you through setting each one
twice by hand. Nothing checks that the two copies agree. An entry code set in
`.env` but never pushed as a Supabase secret produces an app that signs in
fine locally and rejects everyone in production, with no error that points at
the cause.

This adds `scripts/config.mjs`: one interactive front door that reads every
surface, shows their combined state, and writes each logical setting to every
place it belongs.

## 2. What this is not

- **Not a replacement for the README.** The README still explains what a
  Supabase project is and why the anon key is safe to ship. The script assumes
  you're following it and removes the typing, not the reading.
- **Not a deploy tool.** It offers to commit and push `src/config.ts` because
  that value is baked in at build time and is otherwise silently inert. It
  does not trigger workflows, deploy edge functions, or run migrations.
- **Not a secret viewer.** Supabase and GitHub never return secret plaintext,
  and the script never invents a substitute for it. It reports whether a
  secret is set, when it changed, and — where it can prove it — whether it
  matches your local copy.
- **Not non-interactive.** There are no `--set KEY=VALUE` flags. The CLIs it
  wraps already do that job for scripting; this exists for the interactive
  case.
- **Not a new dependency.** Plain `.mjs` on the repo's Node 20, `node:readline/promises`
  for input. No prompt library, no TypeScript runner, no build step.

## 3. Decisions

### 3.1 A setting has targets

The registry's unit is a **logical setting**, not a key in a file. Each
setting declares one or more **targets** — a `(surface, key)` pair. Writing a
setting writes every one of its targets.

```js
{
  id: "entry-code",
  label: "Entry code",
  help: "The 4-digit code your group types to sign in.",
  secret: true,
  targets: [
    { surface: "dotenv",   key: "VITE_ENTRY_CODE" },   // local dev only
    { surface: "supabase", key: "ENTRY_CODE" },        // production
  ],
  validate: v.fourDigits,
  obtain: null,
  wizard: { step: 2, required: true },
}
```

This is the whole reason the script is worth building. The three multi-target
settings — entry code, Supabase URL, Supabase anon key — are exactly the three
the README makes you set twice, and exactly the three that break confusingly
when the copies drift.

`effect` is **not** a field on the setting. It's a property of each target's
surface, and a setting reports the union of its targets' effects:

| Surface               | Effect          | Rendered as                        |
| --------------------- | --------------- | ---------------------------------- |
| `config-file`         | `needs-deploy`  | "takes effect after commit + push" |
| `dotenv`              | `needs-restart` | "restart `npm run dev`"            |
| `supabase`            | `immediate`     | "live now"                         |
| `github` (repo scope) | `needs-deploy`  | "re-run the deploy workflow"       |
| `github` (env scope)  | `next-deploy`   | "used by the next deploy"          |

Deriving it removes a field that could be filled in wrong.

### 3.2 The registry

Eleven settings, fourteen targets.

| id                      | Targets                                                          | Validator                   | Wizard      |
| ----------------------- | ---------------------------------------------------------------- | --------------------------- | ----------- |
| `supabase-url`          | `dotenv:VITE_SUPABASE_URL`, `github/repo:SUPABASE_URL`           | `https://<ref>.supabase.co` | 1, required |
| `supabase-anon-key`     | `dotenv:VITE_SUPABASE_ANON_KEY`, `github/repo:SUPABASE_ANON_KEY` | JWT or `sb_publishable_…`   | 1, required |
| `entry-code`            | `dotenv:VITE_ENTRY_CODE`, `supabase:ENTRY_CODE`                  | exactly 4 digits            | 2, required |
| `default-price`         | `config-file:DEFAULT_PRICE`                                      | positive finite number      | 3, required |
| `currency`              | `config-file:CURRENCY`                                           | 1–3 non-space characters    | 3, required |
| `supabase-access-token` | `github/env:production:SUPABASE_ACCESS_TOKEN`                    | non-empty, no whitespace    | 4, required |
| `supabase-db-password`  | `github/env:production:SUPABASE_DB_PASSWORD`                     | non-empty                   | 4, required |
| `splitwise-api-key`     | `supabase:SPLITWISE_API_KEY`                                     | non-empty, no whitespace    | 5, optional |
| `splitwise-group-id`    | `supabase:SPLITWISE_GROUP_ID`                                    | digits only                 | 5, optional |
| `splitwise-currency`    | `config-file:SPLITWISE_CURRENCY`                                 | 3 uppercase letters         | 5, optional |
| `splitwise-category`    | `config-file:SPLITWISE_CATEGORY_NAME`                            | non-empty                   | 5, optional |

Wizard steps map onto the README's own numbering so the two can be read side
by side. Step 5 is the optional Splitwise block and is skipped entirely on a
"no" answer.

The anon-key validator accepts both the legacy `eyJ…` JWT form and the newer
`sb_publishable_…` form, and **warns rather than blocks** on anything else —
the live check in §3.8 is the real proof, and a format guess that rejects a
valid future key format is worse than a warning.

### 3.3 Surface interface

Four modules, one interface. This is the only code that knows the difference
between a file and a CLI.

```js
export async function probe()            // { available: bool, reason?: string }
export async function read(key)          // TargetState
export async function write(key, value)  // throws on failure
```

`TargetState` is one of:

```js
{ known: true,  present: true,  value: "0.5" }              // config-file, dotenv
{ known: false, present: true,  updatedAt, digest }         // supabase
{ known: false, present: true,  updatedAt }                 // github
{ known: false, present: false }                            // not set
```

`known` is the honesty flag. The Supabase and GitHub surfaces always return
`known: false`, so no rendering path can accidentally print a value that was
never retrieved.

### 3.4 Supabase digests make drift provable

`supabase secrets list -o json` returns, per secret, a `value` field holding
the **SHA-256 hex digest of the plaintext** — not the plaintext. Verified
against this project: `sha256("<the local VITE_ENTRY_CODE>")` reproduces the
`ENTRY_CODE` digest exactly.

So for any setting with both a Supabase target and a locally-readable one, the
script hashes the local value and compares hex. Today that is exactly one
setting — `entry-code`, whose `.env` copy is readable and whose Supabase copy
is not. The Splitwise secrets are Supabase-only, so there is no local value to
hash and their state stays set/unset. Three real states instead of two:

```
Entry code    .env ✓ · Supabase secret ✓ matches
Entry code    .env ✓ · Supabase secret ✓ 5d ago — DIFFERENT from .env
Entry code    .env ✓ · Supabase secret not set — production sign-in will fail
```

The digest is only ever compared, never displayed. For GitHub, no digest is
available, so drift detection there stays at set/unset.

### 3.5 Platform-managed and stray secrets

Supabase injects secrets of its own into every project. On this one:
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`,
`SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY`.

The Supabase surface carries an explicit ignore-list of those names. They are
never offered for editing and never counted as strays.

Note that `SUPABASE_URL` and `SUPABASE_ANON_KEY` each name two unrelated
things: a platform-injected Supabase secret, which this script ignores, and a
GitHub repo secret, which it owns as a target of `supabase-url` /
`supabase-anon-key`. Keys are only ever resolved per surface, never by name
alone, so the collision is harmless — but it is why targets are
`(surface, key)` pairs rather than bare keys.

Anything else present on a surface but absent from the registry is reported
once, at the bottom of the status screen, as information only:

```
  Not managed here
    GitHub repo secret  ENTRY_CODE  (no workflow reads it)
```

This project has exactly that stray today — a leftover from before access-code
validation moved into the `validate-access` edge function. The script reports
strays and **never deletes them**; a secret it doesn't recognise is far more
likely to be something it doesn't know about than something that's safe to
remove.

### 3.6 Three flows over one registry

**Status screen** — printed on every launch. Probes all four surfaces in
parallel, reads every target, groups by surface, and ends with warnings.

```
Chapati Khata — configuration

  App settings                              src/config.ts · needs deploy
    Default price per chapati    0.5
    Currency symbol              $
    Splitwise currency           CAD
    Splitwise category           Groceries

  Connection                                .env + GitHub repo secrets
    Supabase project URL         https://ruole…supabase.co   ✓ both
    Supabase anon key            eyJhbGciOi…                 ✓ both
    Entry code                   .env ✓ · Supabase ✓ matches

  Splitwise                                 Supabase secrets · live now
    API key                      set · 12d ago
    Group id                     set · 12d ago

  Deploy credentials                        GitHub production environment
    Supabase access token        set · 20d ago
    Supabase DB password         set · 20d ago
```

An unavailable surface degrades rather than crashing the run:
`GitHub — gh not authenticated. Run 'gh auth login'. 4 settings hidden.`

**Menu** (`npm run config`) — the same settings, numbered. Choosing one shows
its label, help, current state, and effect; prompts; validates; writes every
target; reports what happened. Loops until you quit.

**Wizard** (`npm run setup`) — walks the registry in `wizard.step` order. A
setting that's already set and valid is shown with `keep this? [Y/n]`. An
unset one is explained, its `obtain` page offered, then prompted and written.
Closes with the live check, a summary, the git offer, and the short list of
things it can't do (see §3.10).

Both modes are `scripts/config.mjs`; `setup` is `config.mjs --setup`.

### 3.7 Obtaining browser-only values

Settings whose value only exists in a browser carry an `obtain` block:

```js
obtain: {
  url: "https://supabase.com/dashboard/project/_/settings/api",
  instructions: "Project Settings → API. Copy the Project URL.",
}
```

The wizard prints the instructions, offers to open the page (`open` on darwin,
`xdg-open` on linux, `start` on win32; on anything else, or if the opener
fails, it prints the URL and continues), waits for Enter, then prompts.

Pages used: Supabase API settings and account access tokens, the Supabase
database settings page, `dev.splitwise.com/apps`, and the repo's own Pages
settings page, resolved from `gh repo view --json nameWithOwner`.

### 3.8 One live check

After both halves of the Supabase connection are known, a single request:

```
GET {url}/rest/v1/
  apikey: {anonKey}
  Authorization: Bearer {anonKey}
```

8-second timeout. A 2xx or 4xx-that-isn't-401/403 confirms the pair is real;
401/403 means the key doesn't match the project. Any network failure is
reported as a **warning, not a blocker** — being offline is not a
configuration error.

No Splitwise call is ever made from the developer machine. The API key belongs
to the edge function's environment, and shape-checking the group id is enough
to catch the realistic mistake (pasting a URL instead of the number).

### 3.9 Secrets never reach argv

Both obvious invocations leak the value into the process argument list, where
any other user on the machine can read it out of `ps`:

```
supabase secrets set ENTRY_CODE=1234        # leaks
gh secret set ENTRY_CODE --body 1234        # leaks
```

Neither is used.

- **GitHub** — `gh secret set NAME` reads the value from **stdin** when
  `--body` is omitted. The value is written to the child's stdin and the pipe
  closed.
- **Supabase** — `supabase secrets set --env-file <path>`. The file is created
  in `os.tmpdir()` with mode `0600`, and unlinked in a `finally` so it does
  not survive a crash or a Ctrl-C.

Alongside that: any setting marked `secret: true` is prompted with echo
suppressed, never echoed back, and never printed in a summary or a git commit
message.

### 3.10 What the script does and doesn't set up

`gh secret set -e production` fails if the environment doesn't exist, so the
GitHub surface detects a missing `production` environment and offers to create
it with `gh api -X PUT repos/{owner}/{repo}/environments/production`. This is
a prerequisite for a target the script owns, not scope creep.

It does **not** create the Supabase project, register the Splitwise app, or
flip Pages to "GitHub Actions" — those are one-time browser actions with no
useful CLI path. The wizard ends by listing whichever of them still look
undone.

### 3.11 Writes are atomic and conservative

File writes go to a temporary file in the same directory, then `fs.rename`, so
an interrupted run never leaves a half-written `.env`.

`.env` is edited **line-wise**: the matching `KEY=` line is replaced in place,
an absent key is appended, and comments, blank lines, ordering, and unrelated
keys are preserved byte-for-byte. It is never regenerated from a template.

`src/config.ts` is the riskiest write, because it is real source that must
still compile. A single anchored pattern targets one
`export const NAME = <literal>;` line and preserves its trailing comment. If
the pattern matches zero times or more than once, the write is **refused**
with a message naming the file and key, rather than guessing. After a
successful write the file is re-read and re-parsed; if the value that comes
back is not the one intended, the original content is restored and the run
errors. No AST parser, no new dependency — but no silent corruption either.

### 3.12 Partial writes are reported, never hidden

A multi-target write is not a transaction. If the first target succeeds and
the second fails, there is no rollback — silently un-setting a secret to
"undo" is worse than the original failure. The script reports precisely how
far it got, and how to finish by hand:

```
Entry code
  ✓ .env               VITE_ENTRY_CODE
  ✗ Supabase secret    ENTRY_CODE — not logged in
    Finish by hand:  supabase secrets set ENTRY_CODE=<value>
```

Validation always runs before any write, so an invalid value produces a
re-prompt rather than a partial application. Ctrl-C at a prompt exits cleanly
with nothing written.

### 3.13 Git, batched on exit

Prompting after every edit gets annoying in a session where you change three
things. Instead the script tracks whether `src/config.ts` changed during the
run and offers **once, on the way out**: shows the diff, then commit + push /
commit only / leave it, with a generated message
(`chore: set default price to 0.75`; multiple changes become
`chore: update app config`).

Two guards:

- It stages `src/config.ts` by path, never `git add -A`, so work in _other_
  files is untouched. Edits you already had in `src/config.ts` before the run
  cannot be separated out by path, so they would ride along in the commit —
  the script detects that case up front, says so, and defaults to
  "leave it" rather than offering a commit it can't cleanly scope.
- If `HEAD` isn't `main`, it says so before pushing — that push won't trigger
  the deploy, and knowing beforehand beats discovering it later.

## 4. Module layout

```
scripts/config.mjs                       entry: arg parsing, mode routing, flows
scripts/config/registry.mjs              the settings table — single source of truth
scripts/config/prompt.mjs                ask / askSecret / confirm / choose / openUrl
scripts/config/validate.mjs              pure validators
scripts/config/git.mjs                   diff / stage / commit / push
scripts/config/surfaces/configFile.mjs   src/config.ts constants
scripts/config/surfaces/dotenv.mjs       .env
scripts/config/surfaces/supabase.mjs     supabase secrets list | set
scripts/config/surfaces/github.mjs       gh secret list | set, repo + env scope
```

`configFile.mjs` and `dotenv.mjs` each expose a pure string layer
(`readConstants(source)` / `setConstant(source, key, literal)`;
`parseEnv(text)` / `setEnvLine(text, key, value)`) with `fs` only at the edges.
That split is what makes the risky text manipulation testable.

## 5. Repo integration

- **`package.json`** — add `"config": "node scripts/config.mjs"` and
  `"setup": "node scripts/config.mjs --setup"`.
- **`vitest.config.ts`** — `include` is currently
  `["src/**/*.{test,spec}.{ts,tsx}"]` and would not pick up any test under
  `scripts/`. Add `"scripts/**/*.{test,spec}.mjs"`.
- **`eslint.config.js`** — the block supplying `globals.node` is scoped to
  `files: ["**/*.{ts,tsx}"]`, so `.mjs` files would fail `no-undef` on
  `process` and `console`. Add a block for `scripts/**/*.mjs` with
  `globals.node` and `sourceType: "module"`.
- **Prettier** — `.mjs` is formatted by default; no `.prettierignore` change.
- **README** — Steps 3 and 4 and the Splitwise section gain a pointer to
  `npm run setup` / `npm run config` as the easier path, with the manual
  commands kept as the explanation of what the script does.

## 6. Testing

Vitest, TDD, in `scripts/config/*.test.mjs`:

- **`validate.mjs`** — every validator, valid and invalid: price rejects `0`,
  negatives, `NaN`, and `Infinity`; currency code requires three uppercase
  letters; group id rejects a pasted URL; entry code requires exactly four
  digits; the anon-key check accepts both key formats and warns rather than
  throws on a third.
- **`configFile.mjs` string layer** — round-trips each of the four constants,
  preserves the trailing `// price per chapati at the default rate` comment,
  refuses on a zero-match key, refuses on a duplicated declaration, and
  handles the string-vs-number literal distinction (`CURRENCY` must stay
  quoted, `DEFAULT_PRICE` must not).
- **`dotenv.mjs` string layer** — replaces in place, appends when absent,
  preserves comments and the commented-out `# VITE_ENTRY_CODE=1234` line
  without treating it as a real key, and leaves unrelated keys byte-identical.
- **Registry integrity** — ids unique, every target names a surface that
  exists, every `validate` is a function, every `wizard.step` is a known step,
  no target is claimed by two settings.

Deliberately not unit-tested: the two CLI surfaces and the prompt loop.
Mocking `child_process` would assert that the code calls the flags this
document says it calls — which is the same assumption the code already
encodes, so it can only ever agree with itself. Those paths are verified by
running the script against this project: read-only listing first, then one
write per surface, checked with `supabase secrets list` and `gh secret list`.

## 7. Deferred

Not in this build, listed so the omissions are visibly deliberate:

- Non-interactive `--set`/`--get` flags.
- Editing anything that already has a UI inside the app (people, sign-in
  permissions, split membership — all in the People sheet, all live in the
  `users` table).
- Deleting stray secrets.
- Reading Splitwise group membership to pre-fill people's linked emails.
- Any second config profile (staging vs. production).
