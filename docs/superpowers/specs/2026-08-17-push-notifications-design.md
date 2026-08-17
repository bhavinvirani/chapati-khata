# Push notifications — design

## 1. Problem

Chapati Khata is already live for everyone in the group, but it only tells you
something happened **while you are looking at it**. `subscribeChanges` in
`src/lib/db.ts` opens a realtime channel on every table and `useKhataData`
reloads on each event, so an open tab updates within a second — and a closed
one learns nothing.

The two moments that actually need to reach people are the two moments money
moves:

- someone **logs an add** — chapatis were bought, and everyone's share just grew;
- someone **settles** — a week (or several) was marked paid.

Today both are silent. You find out by opening the app, or by being told in
person. This adds a real push notification for exactly those two events,
delivered to every signed-in device except the one that caused it.

## 2. What this is not

- **Not a chat bridge.** No Telegram, WhatsApp, SMS, or email channel. One
  channel — Web Push to the installed PWA — and the app remains the only place
  the ledger is read.
- **Not a notification centre.** Nothing is stored to be re-read later. The
  append-only `logs` table is already the history, and the Log tab already
  renders it. A missed notification is not a lost record.
- **Not per-person preferences.** No quiet hours, no mute switch, no digest.
  On or off, per device. At two-or-three events a week the volume does not
  justify the machinery, and the phone's own per-app notification settings are
  the escape hatch.
- **Not an identity system.** The gate is still a name plus a shared 4-digit
  code, and Supabase auth is still anonymous. A subscription is bound to the
  name typed at the gate, which is a label, not a credential — the same
  assumption the rest of the app already makes.
- **Not a delivery guarantee.** Push services drop messages, phones stay off,
  permissions get revoked. Sending is best-effort and must never be able to
  fail a ledger write.

## 3. Decisions

### 3.1 Web Push, not a third-party service

The app is a static site on GitHub Pages with Supabase as its only backend.
Web Push (RFC 8291) with VAPID (RFC 8292) needs no vendor, no SDK in the
bundle, and no account beyond what already exists: a keypair, a table of
subscriptions, and one edge function that signs and sends.

The cost is platform reach, and it needs saying plainly:

| Platform                        | Works?                                                |
| ------------------------------- | ----------------------------------------------------- |
| Android Chrome / Firefox        | Yes, in a browser tab or installed                    |
| Desktop Chrome / Edge / Firefox | Yes                                                   |
| **iPhone / iPad, Safari tab**   | **No.** Apple exposes push only to installed web apps |
| **iPhone / iPad, Home Screen**  | Yes, iOS 16.4+, after Allow                           |

So on iOS the existing `InstallPrompt` stops being a nicety and becomes a
prerequisite. The notification opt-in UI has to say so (§6.2) rather than
offer a button that silently does nothing.

### 3.2 The database fires, not the client

The send is triggered by an `after insert` trigger on `public.logs`, which
calls the sender through `pg_net`.

The alternative — the acting phone calls the edge function right after its
write, the way `src/lib/db.ts` already calls `splitwise` — is less machinery
and was seriously considered. It loses on one point that matters: the phone
that just logged an add is frequently the one about to walk out of Wi-Fi
range. A dropped call there means the write lands and nobody hears about it,
with no trace that anything was missed.

Triggering off `logs` has a second benefit: `logs` is already the project's
canonical record of "a person did a thing". Every write path in `db.ts` ends
in a `logAction` call, so any future one is covered without being remembered.

**The trigger must never fail the write.** `net.http_post` only queues a row
for a background worker, so it does not block — but a missing Vault secret or
any other error inside the function would abort the enclosing `INSERT`. The
function body is therefore wrapped in an `exception when others then return
null` and returns `null` in every path. A misconfigured notification setup
degrades to silence; it never stops someone logging chapatis.

### 3.3 Which log rows notify

```sql
when (new.action in ('create', 'paid'))
```

`create` is a new add; `paid` is a settlement. Deliberately excluded:

- `edit` / `delete` — an evening of fixing one typo should not buzz five phones;
- `reopen`, `splitwise_push`, `splitwise_unpush` — bookkeeping about a payment
  already announced;
- `login`, `user_*` — noise, and `login` alone would fire constantly.

Widening this later is a one-line change to the `when` clause plus a case in
the text composer.

### 3.4 Text is composed from structured columns only

Notification copy: **names and action, no money.**

| Log row          | Title                      | Body                 |
| ---------------- | -------------------------- | -------------------- |
| `create`, qty 21 | `Deven added 21 chapatis`  | `Wed 12 Aug`         |
| `create`, qty 1  | `Deven added 1 chapati`    | `Wed 12 Aug`         |
| `paid`           | `Bhavin settled the khata` | `Week of Mon 11 Aug` |

Everything above comes from `actor`, `qty_after`, `day` and `week_start` —
columns with types. The richer alternative, reusing `logs.detail` (which
already reads `21 @ $0.50 · bhavin 7 · deven 14 · guests 5`), was rejected: it
carries a price, so it would have to be split on its first `·` segment to
strip the money, which turns a display string into a parsed format and makes
`src/lib/logtext.ts` silently load-bearing for a second consumer.

### 3.5 Multi-week settles collapse in the service worker, not the database

`createSettlement` writes one `paid` log row **per week**, so Settle All over
three weeks produces three trigger firings and three sends. Rather than
coalesce them server-side — which needs either an outbox table with a dedupe
key or a `pg_cron` drain, and buys a delay — every notification carries a
`tag`:

- `create` → `tag: "add:<log id>"` (unique; never collapses)
- `paid` → `tag: "paid:<actor>"`

A `showNotification` with a `tag` matching a notification already on screen
**replaces** it, and with `renotify` left at its default `false` it does so
without re-alerting. Three `paid` sends therefore land as one visible
notification and one buzz. The last one wins, so the body names the most
recent week rather than all three — an accepted, documented loss.

### 3.6 A subscription is a device, labelled with a name

```sql
public.push_subscriptions (
  endpoint text primary key,      -- the push service URL; identity of a device
  p256dh   text not null,         -- client public key    ┐ RFC 8291
  auth     text not null,         -- client auth secret   ┘ encryption inputs
  user_name text not null,        -- the name typed at the gate, at subscribe time
  device_id text,                 -- the existing khata.device breadcrumb
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
)
```

`endpoint` is the primary key because the browser already treats it as the
identity of a subscription, and it makes re-subscribing an idempotent upsert.

`user_name` is what makes "skip the actor" work: the sender selects
`user_name <> logs.actor`. It has to stay honest as devices change hands:

- **sign in** — after the gate accepts, rebind any existing subscription on
  this device to the new name;
- **sign out** — unsubscribe in the browser and delete the row, so the next
  person to use that phone does not inherit the previous one's feed.

### 3.7 The keys are hidden by column privileges, not by RLS

A subscription's `p256dh` and `auth` are the encryption inputs for messages to
that device, and the anon key ships in the frontend for anyone to read. They
must not be readable with an ordinary session.

The RLS policy is therefore the **same** `for all to authenticated using
(true)` shape as every other table, and the confidentiality boundary is the
grant instead:

```sql
grant insert, update, delete on public.push_subscriptions to authenticated;
grant select (endpoint, user_name, device_id, created_at, last_seen_at)
  on public.push_subscriptions to authenticated;
```

`select *`, `select p256dh` and `select auth` are then refused by Postgres
before RLS is even consulted, while everything the client legitimately does
still works. `service_role` bypasses RLS and reads the full rows, exactly as
`rate_limit_attempts` is already read.

Two things were tried first and rejected, both because Postgres refuses them,
not on taste — verified against a scratch Postgres 16 running this migration:

- **Omitting the `select` policy entirely** so rows are invisible. This also
  makes them unlocatable: `update`/`delete ... where endpoint = ?` matches
  zero rows and reports success, so a device could neither re-subscribe under
  a new name nor unsubscribe.
- **`on conflict (endpoint) do update`** for the re-subscribe. That form
  requires table-wide `select` privilege, which would hand back the two
  columns this whole decision exists to hide. So `src/lib/db.ts` inserts and
  falls back to an `update` on a `23505` unique violation (§6.1) — two
  statements, both of which work under these grants.

The client never needs to read the table anyway: whether this device is
subscribed is answered by `registration.pushManager.getSubscription()`, which
is local and offline-safe.

### 3.8 The service worker is extended, not replaced

`vite.config.ts` uses `VitePWA`'s default `generateSW` strategy, with a
precache manifest and two runtime-caching rules for Google Fonts. Switching to
`injectManifest` to get a `push` listener would mean hand-writing all of that
in `src/sw.ts` against `workbox-precaching`/`-routing`/`-strategies` — new
dependencies, and a chance to regress offline behaviour that currently works.

Instead: `workbox.importScripts: ["push-sw.js"]`, with a small hand-written
`public/push-sw.js` holding the `push` and `notificationclick` listeners.
`vite-plugin-pwa` passes `workbox` through to `workbox-build`'s `generateSW`
verbatim, so this is a supported option, and the generated worker keeps every
behaviour it has today. `public/push-sw.js` is also matched by the existing
`globPatterns`, so it is precached and available offline.

### 3.9 The public key ships in the bundle

Subscribing needs the VAPID **public** key in the browser. It is public by
definition — the same category as `VITE_SUPABASE_ANON_KEY` — so it is a
build-time `VITE_VAPID_PUBLIC_KEY` rather than a round trip to the edge
function. The private key exists only as a Supabase edge-function secret.

### 3.10 The hook secret lives in Vault

Postgres calling the edge function has no JWT to present, so `notify` runs
with `verify_jwt = false` and authenticates the caller by a shared secret in
an `x-khata-hook` header. The trigger needs to read that secret, and the
function URL, from inside the database: both go into Supabase Vault as
`notify_hook_secret` and `notify_function_url`, read by the trigger's
`security definer` function.

The URL is in Vault rather than hardcoded in the migration because it contains
the project ref, and this repo is meant to be forked and pointed at somebody
else's project.

Writing those two Vault rows is the one setup step no CLI covers. `notify`
therefore accepts a one-off `{"action": "install-hook"}` request, authenticated
by the same `NOTIFY_HOOK_SECRET` it already holds, and writes both rows with
its service-role client. `npm run config` calls it after setting the secrets,
so the whole setup stays inside the wizard (§3.11). The README documents the
equivalent two lines of SQL for anyone who would rather paste them.

### 3.11 Setup goes through `npm run config`

Four new secrets across two surfaces is exactly the set-it-twice-by-hand
problem `scripts/config.mjs` was built to remove, so they are registered as
settings like everything else:

| Setting              | Targets                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `vapid-public-key`   | `dotenv:VITE_VAPID_PUBLIC_KEY`, `github-repo:VITE_VAPID_PUBLIC_KEY`, `supabase:VAPID_PUBLIC_KEY` |
| `vapid-private-key`  | `supabase:VAPID_PRIVATE_KEY` (secret)                                                            |
| `vapid-subject`      | `supabase:VAPID_SUBJECT`                                                                         |
| `notify-hook-secret` | `supabase:NOTIFY_HOOK_SECRET` (secret)                                                           |

A keypair is two values, and the registry's unit is one setting with one
value — so this adds one capability to the registry: an optional
`generate()` that returns values for **several** setting ids at once.
`vapid-public-key` carries it, produces both halves of the keypair with
`node:crypto`, and the wizard offers "generate one for me" instead of asking
the user to find a key that does not exist anywhere yet.

## 4. Architecture

```
someone taps Add / Mark paid
        │
        ▼
  db.addEntry / db.createSettlement          src/lib/db.ts (unchanged)
        │  … writes entries/weeks …
        ▼
  logAction → insert into public.logs
        │
        ▼  after insert, when action in ('create','paid')
  public.notify_push()                       migration, security definer
        │  reads notify_hook_secret + notify_function_url from Vault
        │  never raises — wrapped in exception … return null
        ▼  net.http_post (async, non-blocking)
  supabase/functions/notify                  verify_jwt = false
        │  1. check x-khata-hook
        │  2. compose title/body from the log row
        │  3. select * from push_subscriptions where user_name <> actor
        │  4. encrypt + sign per subscription  (jsr:@negrel/webpush)
        │  5. delete rows the push service answers 404/410 for
        ▼
  push service (FCM / Mozilla / Apple)
        ▼
  public/push-sw.js  → showNotification(title, { body, tag, data.url })
        ▼
  notificationclick  → focus an open window, else open the app
```

## 5. Files

| File                                              | Change | Responsibility                                                     |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `supabase/migrations/<ts>_push_notifications.sql` | new    | table, RLS + grants, `pg_net`, `notify_push()`, trigger            |
| `supabase/schema.sql`                             | edit   | same, in the idempotent one-shot form this file keeps              |
| `supabase/functions/notify/index.ts`              | new    | the sender, plus the `install-hook` bootstrap                      |
| `supabase/functions/notify/deno.json`             | new    | import map, mirroring the other two functions                      |
| `supabase/functions/notify/.npmrc`                | new    | same as the other two                                              |
| `supabase/config.toml`                            | edit   | register `notify` with `verify_jwt = false`                        |
| `public/push-sw.js`                               | new    | `push` + `notificationclick` listeners                             |
| `vite.config.ts`                                  | edit   | `workbox.importScripts: ["push-sw.js"]`                            |
| `src/lib/notifyText.ts`                           | new    | pure title/body composer — the tested reference for the edge fn    |
| `src/lib/notifyText.test.ts`                      | new    | its unit tests                                                     |
| `src/lib/push.ts`                                 | new    | permission, subscribe/unsubscribe, key encoding, capability checks |
| `src/lib/db.ts`                                   | edit   | `savePushSubscription` / `deletePushSubscription`                  |
| `src/hooks/usePushNotifications.ts`               | new    | the state machine the UI renders off                               |
| `src/components/NotifyPrompt.tsx`                 | new    | the dismissible banner                                             |
| `src/components/PeopleSheet.tsx`                  | edit   | a "This device" section with the permanent toggle                  |
| `src/components/icons.tsx`                        | edit   | `IcBell`, `IcBellOff`                                              |
| `src/styles.css`                                  | edit   | `.notify-*` (reusing the `.install` card language), `.ppl-device`  |
| `src/App.tsx`                                     | edit   | render the banner; rebind on sign-in, unsubscribe on sign-out      |
| `src/vite-env.d.ts`                               | edit   | `VITE_VAPID_PUBLIC_KEY`                                            |
| `.env.example`                                    | edit   | document it                                                        |
| `scripts/config/registry.mjs`                     | edit   | four settings + wizard step 6                                      |
| `scripts/config/validate.mjs`                     | edit   | `vapidPublicKey`, `vapidPrivateKey`, `mailtoOrUrl`, `hookSecret`   |
| `scripts/config/vapid.mjs`                        | new    | keypair generation with `node:crypto`                              |
| `scripts/config.mjs`                              | edit   | honour `generate()`; call `install-hook` after writing the secrets |
| `.github/workflows/deploy.yml`                    | edit   | deploy `notify`; pass `VITE_VAPID_PUBLIC_KEY` to the build         |
| `README.md`                                       | edit   | a Notifications section, incl. the iOS Home Screen requirement     |

## 6. Behaviour

### 6.1 Enabling

0. Saving the subscription is an `insert`, falling back to an `update` keyed
   on `endpoint` when it comes back `23505` (§3.7). The fallback is what makes
   re-subscribing and rebinding to a new gate name idempotent.
1. The banner or the People-sheet toggle calls `enable()`.
2. On iOS and not standalone → do not ask for permission. Show the
   Add-to-Home-Screen step instead (`useInstallPrompt` already knows how to
   detect and phrase this).
3. `Notification.requestPermission()` — must be inside the click handler, or
   Safari ignores it.
4. `registration.pushManager.subscribe({ userVisibleOnly: true,
applicationServerKey })`.
5. Upsert the row on `endpoint`, carrying the current gate name and device id.
6. A confirmation toast, via the existing `useToast`.

Denied permission is terminal for that browser — the UI says so and points at
site settings rather than offering a button that cannot work.

### 6.2 What the banner says

Modelled on `InstallPrompt`, dismissible to `localStorage`
(`khata.notifyDismissed`), and shown only when notifications are supported,
not already enabled, not previously denied, and not dismissed.

- Installed, or Android/desktop → "Get a nudge when someone adds or settles."
  with a **Turn on** button.
- iOS, not installed → the Share → Add to Home Screen steps, no button.

### 6.3 Receiving

`push` → `showNotification(title, { body, tag, icon: pwa-192, badge, data: { url } })`.
A payload that fails to parse still shows a generic "Chapati Khata" card,
because `userVisibleOnly: true` means a silent push costs the site its
permission.

`notificationclick` → close it, then focus an already-open client if one is
on the app's scope, else `clients.openWindow(data.url)`.

### 6.4 Pruning

`404` or `410` from the push service means the subscription is permanently
gone (unsubscribed, app deleted, browser data cleared). The sender deletes
that row immediately. Any other failure is left alone and retried by the next
event — there is no retry queue, on purpose.

## 7. Security notes

- The VAPID **private key** and the hook secret exist only as Supabase
  edge-function secrets and, for the hook secret, one Vault row. Neither is in
  git, in the bundle, or in a GitHub secret.
- `notify` runs with `verify_jwt = false` — the header secret is the whole
  gate, so it is compared with a length-independent equality check and the
  function returns `401` with no body on a mismatch.
- `install-hook` is guarded by the same secret and is idempotent.
- Subscription keys are unreadable with the anon key (§3.7). The worst a
  holder of the anon key can do is insert a subscription of their own or
  delete one whose endpoint they already know.
- Notification content carries names and quantities, never amounts, and lands
  on lock screens by design (§3.4).

## 8. Testing

- `src/lib/notifyText.test.ts` — singular/plural, a settle, an unknown action,
  date formatting at the timezone the suite pins (`America/Toronto`).
- `src/lib/push.test.ts` — `urlBase64ToUint8Array` round-trips, and the
  capability matrix (no `serviceWorker`, no `PushManager`, iOS-not-standalone,
  permission already `denied`).
- `scripts/config/validate.test.ts` — the four new validators.
- `scripts/config/vapid.test.ts` — a generated key is 65 raw bytes,
  base64url, and imports back through WebCrypto.
- Manual, and unavoidable: one Android install and one iPhone install, adding
  an entry from a third device, checking the actor is skipped and the tag
  collapses a Settle All.

## 9. Rollout

The migration is additive — a new table, a new extension, a new trigger. No
existing column changes, nothing is dropped, so `ci.yml`'s destructive-migration
guard passes untouched.

Until the secrets are set, `notify_push()` finds no Vault rows and returns
immediately: the app on `main` behaves exactly as it does today. Setting the
secrets and running `install-hook` is what switches it on, and it can be
switched back off by deleting the two Vault rows.

## 10. Known limitations

1. **iOS needs the app on the Home Screen.** No way around it; the UI has to
   teach it.
2. **A multi-week Settle All shows only the last week** (§3.5).
3. **A notification is lost if the phone is off for days** — push services
   have a TTL. Nothing is stored; the Log tab remains the record.
4. **`user_name` is a label, not an identity.** Someone signing in as another
   person's name will be skipped as if they were that person. This is the same
   trust model the gate already has.
5. **No delivery reporting.** Failures other than 404/410 are logged to the
   function's console and otherwise ignored.
