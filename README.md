# Chapati Khata

A shared roti tab for a small group. Everyone logs how many chapatis they order
from the seller each day; the app splits each order across whoever actually ate,
rolls it up per week (Monday–Sunday), and tracks what's owed until the week is
marked paid. Data lives in your own Supabase (Postgres) database, so it's
permanent and portable.

- **Shared** - one live tab; every device sees the same numbers, updated in real time.
- **Light gate** - type your name (from the group's list, managed in-app) and a shared access code to enter. No passwords.
- **Split by person** - each add is divided across whoever actually had some, so the tab tracks who owes what, not just a group total.
- **People management** - add or remove people, and independently control who's offered in the split vs. who can sign in, all from an in-app sheet.
- **Push to Splitwise** _(optional)_ - once a week (or several settled together) is paid, push one matching expense straight to your real Splitwise group instead of typing it in by hand.
- **Auditable** - every add, edit, delete, payment, people change, and Splitwise push/removal is recorded in an append-only log.
- **Flexible dates** - add entries for today or any past date you missed.
- **Custom pricing** - enter `50x0.75` for 50 chapatis at 0.75 each.
- **Yours** - export the whole thing to JSON anytime; the database is your account.

---

## What you'll need (all free)

1. A [Supabase](https://supabase.com) account.
2. [Node.js](https://nodejs.org) 20.19+ installed locally (see [`.nvmrc`](.nvmrc)).
3. A GitHub account (to host the code and run the deploy/keep-alive jobs).
4. The [Supabase CLI](https://supabase.com/docs/guides/cli) installed locally — only needed for the one-time secret setup below, not for day-to-day use.
5. _(Optional, for the Splitwise integration)_ A [Splitwise](https://www.splitwise.com) account, a group on it, and a personal API key from [dev.splitwise.com](https://dev.splitwise.com).

---

## Step 1 - Create the database (Supabase)

1. Create a new project at [supabase.com](https://supabase.com). Pick a strong
   database password and a region near your group. Wait ~2 minutes for it to spin up.
2. **Enable anonymous sign-ins.** Go to **Authentication > Sign In / Providers**
   (in some dashboards it's **Authentication > Settings**) and turn on
   **"Allow anonymous sign-ins."** This is what lets the app open without a login
   while still keeping random internet traffic out.
3. **Create the tables.** Open **SQL Editor > New query**, paste the entire
   contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
   You should see "Success. No rows returned." This creates all seven tables
   (`weeks`, `entries`, `entry_shares`, `users`, `settlements`,
   `rate_limit_attempts`, `logs`), their access rules, and realtime
   publication in one shot.
4. **Tell the migration history it's already applied.** This repo tracks schema
   changes as numbered files under [`supabase/migrations/`](supabase/migrations/),
   and step 5's automated deploy runs them on every push. Since you just created
   the same schema by hand, stamp the existing migrations as already-done so it
   doesn't try to recreate them:
   ```bash
   supabase link --project-ref <your-project-ref>
   supabase migration repair --status applied \
     20260725195338 20260726003110 20260726080036 \
     20260726120000 20260726130000 20260726140000 20260727010000
   ```
   (Your project ref is the subdomain in your project URL, e.g. `abcd1234` from
   `https://abcd1234.supabase.co`.) Any _new_ migration added after this point
   applies automatically on your next push — this one-time step is only for the
   history that already existed when you cloned the repo.
5. **Grab your keys.** Go to **Project Settings > API** and copy two values:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long string under "Project API keys")

> These two values are _meant_ to be public - they ship in the frontend. Your
> data is protected by the database rules (Row-Level Security), not by hiding the
> key. Your **service_role** key and DB password are the real secrets - never put
> those in this project.

---

## Step 2 - Run it locally

```bash
cp .env.example .env
```

Open `.env` and paste in the two values from Step 1, and pick a local access code:

```
VITE_SUPABASE_URL=https://abcd1234.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...your-anon-key...
VITE_ENTRY_CODE=1234
```

`VITE_ENTRY_CODE` is a local-only shortcut — with it set, the app checks the
code against this value directly instead of calling the production edge
function (which isn't deployed yet at this point). Leave it unset once you
deploy for real; see Step 3.

Then:

```bash
npm install
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`). You'll be the only
person in the group at first — the People sheet (the icon next to the app
name) starts empty, so add yourself and anyone else before adding entries.
Type your name and the access code to enter, add a few chapatis, and confirm
it works. Open the same URL in a second browser/phone - changes should appear
live in both.

---

## Step 3 - Set your group's names, split, and price

Who can sign in, and who's offered when splitting an entry, both live in the
`users` table, managed from the **People** sheet inside the app - no file to
edit, no redeploy needed. Add or remove someone, or toggle either switch, and
it takes effect right away. The two switches are independent: someone can be
in the split but unable to sign in (they eat, someone else logs it), or able
to sign in but out of the split (on a break).

The fastest way to set any of this is `npm run setup` for a guided first run,
or `npm run config` to change one thing later. Both show what's already set
across all four places config lives, and write each value everywhere it
belongs. The manual steps below are what those commands do.

Price and currency symbol live in [`src/config.ts`](src/config.ts):

```ts
export const DEFAULT_PRICE = 0.5; // per chapati
export const CURRENCY = "$";
```

Names are matched case-insensitively.

**Price tip:** the default price applies to every entry. If one day had a
different rate, type it in the add box as `count x price`, e.g. `50x0.75`
(fifty chapatis at 0.75 each). A day may hold several adds, and each add
stores its own rate, so mixed prices on the same day add up correctly.

---

## Step 4 - Put the code on GitHub and deploy

```bash
git init
git add .
git commit -m "Chapati Khata"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<you>/chapati-khata.git
git push -u origin main
```

`.env` is gitignored, so your keys won't be committed.

This repo ships [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml),
which on every push to `main`: applies any pending database migrations,
(re)deploys both edge functions, builds the site, publishes it to GitHub
Pages, and tags a release. This is the recommended path, since it's the only
one that also keeps your database schema and edge functions in sync with the
code automatically — if you deploy the frontend somewhere else instead
(Cloudflare Pages, Netlify, Vercel), you'll need to run
`supabase db push` and `supabase functions deploy <name>` yourself by hand
whenever either changes.

**One-time setup:**

1. **Settings > Pages > Build and deployment > Source: "GitHub Actions."**
2. Add two **repository secrets** under **Settings > Secrets and variables >
   Actions**: `SUPABASE_URL` and `SUPABASE_ANON_KEY` - the same two values
   from Step 1 (also used by the keep-alive job in Step 6, so you only add
   them once). `npm run config` sets these and their `.env` counterparts
   together, so the two copies can't drift apart.
3. Create a **production environment** (**Settings > Environments > New
   environment**, name it `production`) and add two **environment secrets**
   there, scoped to it rather than repo-wide since they grant real write
   access to your account and database:
   - `SUPABASE_ACCESS_TOKEN` - from your Supabase account's
     **Access Tokens** page.
   - `SUPABASE_DB_PASSWORD` - the database password you set in Step 1
     (**Project Settings > Database** if you need to reset it).
4. **Set the login code**, since it's validated server-side in production by
   the `validate-access` edge function, not read from `.env`:
   ```bash
   supabase secrets set ENTRY_CODE=<the code your group will type to sign in>
   ```
   `npm run config` writes this to both `.env` and Supabase in one go.
5. Push to `main` (or re-run the workflow from the **Actions** tab). It
   derives the site's base path from your repo name (`/<repo>/`)
   automatically. Your site lands at `https://<you>.github.io/<repo>/`.

Because Vite bakes `VITE_*` values in at **build time**, changing
`SUPABASE_URL`/`SUPABASE_ANON_KEY` means re-running the deploy - push again,
or trigger it from the **Actions** tab. `ENTRY_CODE` and the Splitwise
secrets below take effect immediately on their next use instead, since
they're read at request time by the edge functions, not baked into the
frontend build.

---

## Optional: Connect Splitwise

Once this is set up, a paid week (or several paid together) gets a **Push to
Splitwise** button that creates one matching expense in a real Splitwise
group - no typing shares in by hand. Skip this section entirely if you don't
want it; everything else works the same without it.

1. **Get a personal API key.** Sign into [dev.splitwise.com](https://dev.splitwise.com),
   register an application, and copy the **API key** shown on its page (not
   the Consumer Key/Secret - those are for the OAuth flow, which this
   integration doesn't use).
2. **Find your group's ID.** Open the target group on splitwise.com - the
   number in the page URL is the group ID.
3. **Set both as Supabase secrets** (never as `VITE_*` values - they must
   never reach the browser):
   ```bash
   supabase secrets set SPLITWISE_API_KEY=<your key> SPLITWISE_GROUP_ID=<your group id>
   ```
   or via the dashboard: **Edge Functions > splitwise > Secrets**, or
   `npm run config`, which validates the group id before setting it.
4. **Link each person.** In the People sheet, each row gets a Splitwise
   email field - type the email that person uses on Splitwise and it checks
   against the live group and shows Linked/Not linked. Someone must be
   linked before their share can be included in a push.
5. Push a small, single week first to see the result in Splitwise before
   trusting it with a larger one.

Notes:

- The expense is always created in **CAD** under Splitwise's **Groceries**
  category, regardless of the `$` symbol set in Step 3 - change
  `SPLITWISE_CURRENCY`/`SPLITWISE_CATEGORY_NAME` in
  [`src/config.ts`](src/config.ts) if your group uses a different currency.
- Reopening a pushed week deletes its Splitwise expense first, then reverts
  it to unpaid here. Weeks paid together in one click share one expense, so
  reopening any one of them reopens the whole group.
- This app never reads anything back from Splitwise - it only creates an
  expense on push and deletes it on reopen. Editing the expense inside
  Splitwise afterward is invisible to this app.
- Testing against your real group isn't necessary - point `SPLITWISE_GROUP_ID`
  (and optionally a separate `SPLITWISE_API_KEY`) at a disposable test group
  while you try it out, then switch back to your real one.

---

## Step 5 - Keep the database awake

A free Supabase project pauses after about 7 idle days. This repo includes a
GitHub Action ([`.github/workflows/keep-alive.yml`](.github/workflows/keep-alive.yml))
that pings it once a day. It reuses the same `SUPABASE_URL` and
`SUPABASE_ANON_KEY` repository secrets from Step 4 - nothing new to add if
you already set those up.

The job runs daily on its own. Trigger it manually from the **Actions** tab to test.

---

## Backups

Tap the download icon in the app header any time to save a full JSON snapshot
(weeks, users, entries - including paid ones - and the complete log). Keep
one now and then; it's your data. The snapshot doesn't include Splitwise
push status or linked emails, since those are recoverable from Splitwise and
the People sheet respectively rather than being the source of truth for
anything.

---

## How it's built

- **Vite + React + TypeScript**, plain CSS (no UI framework).
- **Supabase** (hosted Postgres + Edge Functions) for shared, durable storage,
  realtime updates, and the two server-side checks that must never run in the
  browser (the login code, and the Splitwise API key).
- Seven tables - `weeks`, `entries`, `entry_shares`, `users`, `settlements`,
  `rate_limit_attempts`, `logs`. An add's cost is split per person into
  `entry_shares`; a `settlement` groups whichever weeks were paid together in
  one click and is the unit a Splitwise push covers. See
  [`supabase/schema.sql`](supabase/schema.sql) for a fresh install, or
  [`supabase/migrations/`](supabase/migrations/) for the schema's history.
- All database access is isolated in [`src/lib/db.ts`](src/lib/db.ts). Swap backends
  by rewriting one file.
- Two edge functions in [`supabase/functions/`](supabase/functions/):
  `validate-access` (checks the sign-in code + name server-side, rate-limited
  by IP) and `splitwise` (the only thing that holds the Splitwise API key -
  proxies linking a person, pushing an expense, and deleting one on reopen;
  also rate-limited). Both share the throttling logic in
  [`supabase/functions/_shared/rateLimit.ts`](supabase/functions/_shared/rateLimit.ts).

```
src/
  scripts/config.mjs      # interactive setup + config editor
  config.ts               # price, currency, Splitwise currency/category
  types.ts                # shared TypeScript types
  hooks/
    useAuth.ts            # sign-in / sign-out state
    useKhataData.ts       # data loading, realtime, derived state
    useToast.ts           # toast notifications
    useConfirm.ts         # confirmation dialog state
  lib/
    supabase.ts           # client + anonymous-auth gate
    db.ts                 # every read/write + realtime subscription
    device.ts             # random per-device breadcrumb for the log
    util.ts               # money, dates, week math, input parsing
    split.ts              # per-person allocation math for one add
    aggregate.ts          # turning stored rows into what the UI shows
    people.ts             # who can be edited/deleted, in what order
    logtext.ts            # human-readable "what changed" for the log
    splitwise.ts          # settlement labels, link/share helpers for the push flow
  components/
    Gate.tsx              # name + code sign-in
    Header.tsx             # app header bar
    TabSwitcher.tsx        # ledger / log tabs
    AddForm.tsx             # add entry form with date picker + split composer
    SplitEditor.tsx         # the per-person allocation UI inside AddForm/EditSheet
    ToPayCard.tsx           # payment summary + Settle All
    WeekCard.tsx            # a week's slip of entries
    PaidHistory.tsx         # collapsed history, grouped by settlement
    SplitwiseControl.tsx    # the push/pushed/retry control, shared by WeekCard and PaidHistory
    SettleSummary.tsx       # per-person breakdown shown before marking paid
    PushSummary.tsx         # same breakdown + payer picker shown before pushing
    PeopleSheet.tsx         # add/remove people, split/login switches, Splitwise email
    EditSheet.tsx           # edit / delete a day
    StatsSheet.tsx          # lifetime stats
    LogView.tsx             # change history with pagination
    ConfirmDialog.tsx       # confirmation modal
    BootScreen.tsx          # loading screen
    OfflineBanner.tsx       # offline warning
    Toast.tsx               # toast notification
    icons.tsx               # inline SVG icons + the roti mark
  App.tsx                 # orchestrator
  main.tsx                # entry point
  styles.css              # design system
supabase/
  schema.sql              # fresh-install reference (run once in the SQL Editor)
  migrations/             # incremental schema history (applied by deploy.yml)
  functions/
    validate-access/      # server-side sign-in check, rate-limited
    splitwise/             # link/push/delete proxy — the only holder of the API key, rate-limited
    _shared/
      rateLimit.ts          # shared IP-keyed failure-counter used by both functions above
```

## A note on the "light gate"

The name + code check is convenience, not security - anyone with the link, a
valid name, and the code can act, and the name recorded in the log is on the
honor system. The real safeguard is that **every action is logged and
reversible**: if something looks wrong, open the Log tab, see exactly what
changed, and undo it (reopen a week, fix or re-add an entry). That's
proportionate for a small, trusted group tracking roti.

A 4-digit code is brute-forceable in well under a minute with no throttle,
so `validate-access` and `splitwise` both count failed attempts per IP in
the `rate_limit_attempts` table and return `429` after 8 failures in 15
minutes. Only failures count, so normal use - including a few housemates
sharing one home IP - never trips it.
