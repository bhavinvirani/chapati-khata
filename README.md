# Chapati Khata

A shared roti tab for a small group. Everyone logs how many chapatis they order
from the seller each day; the app rolls it up per week (Monday–Sunday) and tracks
what's owed until the week is marked paid. Data lives in your own Supabase
(Postgres) database, so it's permanent and portable — not locked inside any one
app.

- **Shared** — one live tab; every device sees the same numbers, updated in real time.
- **Light gate** — type your name (from an allowlist) to enter. No passwords.
- **Auditable** — every add, edit, delete, and payment is recorded in an append-only log.
- **Yours** — export the whole thing to JSON anytime; the database is your account.

---

## What you'll need (all free)

1. A [Supabase](https://supabase.com) account.
2. [Node.js](https://nodejs.org) 18+ installed locally.
3. A GitHub account (to host the code and run the keep-alive job).
4. A static host — **Cloudflare Pages**, **Netlify**, or **Vercel** (any is fine),
   or **GitHub Pages**.

---

## Step 1 — Create the database (Supabase)

1. Create a new project at [supabase.com](https://supabase.com). Pick a strong
   database password and a region near your group. Wait ~2 minutes for it to spin up.
2. **Enable anonymous sign-ins.** Go to **Authentication → Sign In / Providers**
   (in some dashboards it's **Authentication → Settings**) and turn on
   **"Allow anonymous sign-ins."** This is what lets the app open without a login
   while still keeping random internet traffic out.
3. **Create the tables.** Open **SQL Editor → New query**, paste the entire
   contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
   You should see "Success. No rows returned."
4. **Grab your keys.** Go to **Project Settings → API** and copy two values:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long string under "Project API keys")

> These two values are *meant* to be public — they ship in the frontend. Your
> data is protected by the database rules (Row-Level Security), not by hiding the
> key. Your **service_role** key and DB password are the real secrets — never put
> those in this project.

---

## Step 2 — Run it locally

```bash
# from the project folder
cp .env.example .env
```

Open `.env` and paste in the two values from Step 1:

```
VITE_SUPABASE_URL=https://abcd1234.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...your-anon-key...
```

Then:

```bash
npm install
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`). Type one of the names
from the allowlist to enter, add a few chapatis, and confirm it works. Open the
same URL in a second browser/phone — changes should appear live in both.

---

## Step 3 — Set your group's names and price

Edit [`src/config.ts`](src/config.ts):

```ts
export const ALLOWED_NAMES = ["bhavin", "abhishek", "deven", "parth", "pratik", "hitanshi"];
export const DEFAULT_PRICE = 0.5; // per chapati
export const CURRENCY = "$";
```

Names are matched case-insensitively. To add or remove someone, just edit this
list and redeploy.

**Price tip:** the default price applies to every entry. If one day had a
different rate, type it in the add box as `count x price`, e.g. `50x0.75`
(fifty chapatis at 0.75 each). The day stores the money, so mixed prices add up
correctly.

---

## Step 4 — Put the code on GitHub

```bash
git init
git add .
git commit -m "Chapati Khata"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<you>/chapati-khata.git
git push -u origin main
```

`.env` is gitignored, so your keys won't be committed. Good.

---

## Step 5 — Deploy the site

Pick **one**.

### Option A — Cloudflare Pages / Netlify / Vercel (recommended)

Connect the GitHub repo in their dashboard and use:

- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Environment variables:** add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
  with the same values as your `.env`.

Every `git push` redeploys automatically. Share the URL with your group (and the
seller, if you like — they see the same tab).

### Option B — GitHub Pages (workflow included)

This repo ships `.github/workflows/deploy.yml`, which builds and publishes to
Pages on every push to `main`. To turn it on:

1. **Settings → Pages → Build and deployment → Source: "GitHub Actions".**
2. Add two repo secrets under **Settings → Secrets and variables → Actions** —
   `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the *same* two the keep-alive job uses,
   so you only add them once). Add them **before** the first deploy.
3. Push to `main`. The workflow derives the base path from your repo name
   (`/<repo>/`) automatically, builds, and deploys. Your site lands at
   `https://<you>.github.io/<repo>/`.

Because Vite bakes env values in at **build time**, changing a secret means
re-running the deploy — push again, or run it from the **Actions** tab. This app
has a single view (no client-side routes), so the usual Pages "refresh gives 404"
problem doesn't apply here.

---

## Step 6 — Keep the database awake

A free Supabase project pauses after about 7 idle days. This repo includes a
GitHub Action ([`.github/workflows/keep-alive.yml`](.github/workflows/keep-alive.yml))
that pings it once a day. To enable it:

1. In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret.**
2. Add **`SUPABASE_URL`** = your Project URL.
3. Add **`SUPABASE_ANON_KEY`** = your anon public key.

That's it — the job runs daily on its own. You can also trigger it manually from
the **Actions** tab to test it.

---

## Backups

Tap the download icon in the app header any time to save a full JSON snapshot
(weeks, entries, and the complete log). Keep one now and then; it's your data.

---

## How it's built

- **Vite + React + TypeScript**, plain CSS (no UI framework).
- **Supabase** (hosted Postgres) for shared, durable storage + realtime updates.
- Three tables — `weeks`, `entries`, `logs` — with money stored per entry and all
  totals derived in the UI. See [`supabase/schema.sql`](supabase/schema.sql).
- All database access is isolated in [`src/lib/db.ts`](src/lib/db.ts). Nothing else
  touches Supabase, so swapping backends later means rewriting one file.

```
src/
  config.ts            # names, price, currency — the stuff you edit
  types.ts             # shared TypeScript types
  lib/
    supabase.ts        # client + anonymous-auth gate
    db.ts              # every read/write + realtime subscription
    device.ts          # random per-device breadcrumb for the log
    util.ts            # money, dates, week math, input parsing
  components/
    Gate.tsx           # name sign-in
    WeekCard.tsx       # a week's slip of entries
    EditSheet.tsx      # edit / delete a day
    LogView.tsx        # the change history
    icons.tsx          # inline SVG icons + the roti mark
  App.tsx              # wires it together
  main.tsx             # entry point
  styles.css           # the design system
```

## A note on the "light gate"

The name check is convenience, not security — anyone with the link and a valid
name can act, and the name recorded in the log is on the honor system. The real
safeguard is that **every action is logged and reversible**: if something looks
wrong, open the Log tab, see exactly what changed, and undo it (reopen a week,
fix or re-add an entry). That's proportionate for a small, trusted group tracking
roti. If you ever need true per-person accountability, the next step up is real
per-person login — ask and it can be added.
