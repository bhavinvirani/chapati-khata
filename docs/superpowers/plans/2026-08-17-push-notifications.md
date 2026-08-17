# Push Notifications Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Work the tasks in order — each one leaves the repo green (`npm run lint && npm run typecheck && npm test && npm run format:check`).

**Goal:** When someone logs an add or settles a week, every other signed-in device gets a push notification — including when the app is closed.

**Architecture:** An `after insert` trigger on `public.logs` calls a `notify` edge function through `pg_net`. The function composes the text from the log row's structured columns, loads every `push_subscriptions` row whose `user_name` differs from the actor, and sends an encrypted Web Push message to each. A small `push-sw.js`, imported into the existing generated service worker, shows the notification.

**Tech Stack:** Existing — React 18 + Vite + `vite-plugin-pwa` (`generateSW`), Supabase (Postgres + Deno edge functions), Vitest. One new runtime dependency, and it is Deno-side only: `jsr:@negrel/webpush`. Nothing is added to `package.json`.

**Source spec:** `docs/superpowers/specs/2026-08-17-push-notifications-design.md`

**Branch:** `claude/push-notifications-logs-payments-lyljhv`

## Global Constraints

- **No new npm dependencies.** Not in `dependencies`, not in `devDependencies`. The service worker addition is plain JS in `public/`; the Web Push library is a `jsr:` import inside the edge function only.
- **The trigger can never fail a write.** `notify_push()` returns `null` on every path and wraps its body in `exception when others then return null`. A missing secret, an unreachable function, a malformed row — all degrade to silence, never to a failed `INSERT` on `logs`.
- **Migrations are additive.** No `drop`, no `truncate`, no `delete from`, no column type change — so `ci.yml`'s destructive-migration guard needs no `-- allow-destructive` escape hatch. Filename must match `<14-digit-timestamp>_name.sql`.
- **`supabase/schema.sql` and the migration stay in step.** The migration is the applied artifact; `schema.sql` is the idempotent one-shot for a fresh project. Every change lands in both, in each file's own style (`create table if not exists`, guarded `do $$` blocks).
- **Secrets never reach argv or git.** The VAPID private key and hook secret go to Supabase through the existing `--env-file` path in `scripts/config/surfaces/supabase.mjs`. Only the _public_ key is ever written to `.env`, a GitHub secret, or the bundle.
- **Subscription keys stay unreadable to the frontend.** `push_subscriptions` grants `select` on every column _except_ `p256dh` and `auth`. Never chain `.select()` onto a write against that table, and never use `.upsert()` on it — `on conflict do update` requires table-wide select privilege and will fail, correctly.
- **Prettier formats everything it owns.** `npx prettier --write` on touched files before each commit; `npm run format:check` passes at the end. `supabase/functions/` is in `.prettierignore` and eslint's ignore list — `deno fmt` and `deno lint` own it — so match the surrounding style there by hand.
- **iOS is a first-class case, not an afterthought.** Any code path that could ask for notification permission checks "iOS and not standalone" first.

## File Structure

| File                                              | Responsibility                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `supabase/migrations/<ts>_push_notifications.sql` | Table, RLS, grants, `pg_net`, `notify_push()`, trigger             |
| `supabase/functions/notify/index.ts`              | Sender + `install-hook` bootstrap                                  |
| `public/push-sw.js`                               | `push` and `notificationclick` listeners                           |
| `supabase/functions/_shared/notifyText.ts`        | Pure title/body composer — one copy, imported by the edge function |
| `src/lib/push.ts`                                 | Browser-side capability checks, subscribe/unsubscribe, key coding  |
| `src/hooks/usePushNotifications.ts`               | The state the banner and the toggle both render off                |
| `src/components/NotifyPrompt.tsx`                 | The dismissible opt-in card                                        |
| `scripts/config/vapid.mjs`                        | Keypair generation with `node:crypto`                              |

---

### Task 1: The database side

The trigger and table first — everything else has an opinion about their shape, and this task alone is safely deployable to production (it stays inert until §Task 5 sets the secrets).

**Files:**

- Create: `supabase/migrations/20260817120000_push_notifications.sql`
- Modify: `supabase/schema.sql`

**Steps:**

- [x] `create extension if not exists pg_net;` — pg_net is not relocatable and creates its own `net` schema, so no `with schema` clause.
- [x] Create `public.push_subscriptions` per spec §3.6: `endpoint text primary key`, `p256dh`, `auth`, `user_name` (all `not null`), `device_id`, `created_at`, `last_seen_at`. Index on `user_name`.
- [x] Enable RLS with the project's usual `for all to authenticated using (true) with check (true)` policy. Confidentiality comes from the grant, not from row visibility — omitting the `select` policy makes rows unlocatable for `update`/`delete ... where endpoint = ?`, which silently breaks unsubscribing.
- [x] `grant insert, update, delete on public.push_subscriptions to authenticated;` and `grant select (endpoint, user_name, device_id, created_at, last_seen_at) on public.push_subscriptions to authenticated;` — every column except `p256dh` and `auth`, so `select *` is refused by Postgres before RLS is consulted.
- [x] Write `public.notify_push()` — `language plpgsql`, `security definer`, `set search_path = ''` with every reference schema-qualified. Body: read `notify_hook_secret` and `notify_function_url` from `vault.decrypted_secrets`; `return null` if either is missing; otherwise `perform net.http_post(url, headers => jsonb with 'Content-Type' and 'x-khata-hook', body => jsonb_build_object('log', to_jsonb(new)), timeout_milliseconds => 5000)`; `return null`.
- [x] Wrap that whole body in `exception when others then return null;`. Add a comment saying why in one sentence — this is the single most important line in the migration.
- [x] `revoke execute on function public.notify_push() from public, anon, authenticated;` — a `security definer` function that can read Vault must not be callable directly.
- [x] `create trigger logs_notify_push after insert on public.logs for each row when (new.action in ('create','paid')) execute function public.notify_push();`
- [x] Mirror all of it into `supabase/schema.sql` in that file's idempotent style: `if not exists` on the table and index, `drop policy if exists` before each `create policy` (matching the existing block), `create or replace function`, and a `drop trigger if exists` before the `create trigger`.
- [x] Verify the filename matches `^[0-9]{14}_[a-zA-Z0-9_]+\.sql$` and that `grep -v '^[[:space:]]*--' <file> | grep -iE 'drop table|drop column|truncate|delete from'` finds nothing.

**Verify:** done against a scratch Postgres 16 with `vault`, `net.http_post` and `public.logs` stubbed — 24 assertions covering: the migration applies clean; the write lands with no Vault rows, with `net.http_post` raising, with the `net` schema dropped, and with the `vault` schema dropped; `create`/`paid` fire and ten other actions do not; the posted body carries the whole log row and the hook header; a session can subscribe, rebind and unsubscribe; `select *`/`p256dh`/`auth` and a direct `notify_push()` call are refused; `service_role` reads the keys and prunes.

---

### Task 2: The notification text

Pure functions, no I/O, so they come before both consumers.

**Where it lives.** The plan originally put this in `src/lib/` as a tested
_reference_ for a hand-kept copy inside the edge function, following the
precedent of `normalizeName` and `normalizeEmail`. That turned out to be
avoidable: the edge function is the composer's only consumer, and a module
with no imports and no `Deno.*` can be imported by both Deno and vitest. So
there is **one** copy, in `supabase/functions/_shared/`, and `vitest.config.ts`
widens its `include` to reach it — the same widening `scripts/` already got.

Its `cap`/`dayLabel`/`weekLabel` are still mirrors of `src/lib/util.ts`, since
Deno cannot import from `src`. Those are pinned by an executable check rather
than a comment: the test imports the real `util.ts` and asserts the two agree
across every day and every Monday of a year.

**Files:**

- Create: `supabase/functions/_shared/notifyText.ts`, `supabase/functions/_shared/notifyText.test.ts`
- Modify: `vitest.config.ts`

**Steps:**

- [x] Define `NotifiableLog` — the subset of `LogRow` the composer needs: `id`, `actor`, `action`, `qty_after`, `day`, `week_start`.
- [x] `notifyText(log): { title: string; body: string; tag: string } | null`. Returns `null` for any action outside `create` / `paid`, so the composer — not the caller — owns the list.
  - `create` → title `` `${cap(actor)} added ${qty} ${qty === 1 ? "chapati" : "chapatis"}` ``, body the short day label, tag `` `add:${id}` ``.
  - `paid` → title `` `${cap(actor)} settled the khata` ``, body `` `Week of ${label}` ``, tag `` `paid:${actor}` ``.
- [x] Mirror `cap`, `dayLabel` and `weekLabel` from `src/lib/util.ts` locally, and pin them with a test that imports the originals and compares over a year of dates.
- [x] Guard the degenerate rows the type allows but the writer never produces: a `create` with `qty_after` null, a `paid` with `week_start` null. Fall back to a bodyless notification rather than rendering `null`.
- [x] Tests: singular vs plural, a settle, thirteen excluded actions returning `null`, a null `qty_after`/`day`/`week_start`, a blank actor, tag collapsing for a Settle All, tag separation between people, no currency anywhere, and the drift checks above. 27 in all.

**Verify:** `npm test`

---

### Task 3: The edge function

**Files:**

- Create: `supabase/functions/notify/index.ts`, `supabase/functions/notify/deno.json`, `supabase/functions/notify/.npmrc`
- Modify: `supabase/config.toml`

**Steps:**

- [x] Copy `.npmrc` and the shape of `deno.json` from `supabase/functions/splitwise/`. Pinned `jsr:@negrel/webpush@^0.5` — 0.5.0 is the version in the library's own `deno.json` on master, and its API was read from source: `importVapidKeys({publicKey, privateKey}: JWKs)`, `ApplicationServer.new({contactInformation, vapidKeys})`, `.subscribe({endpoint, keys})`, `.pushTextMessage(text, {ttl})`, and a `PushMessageError` carrying `.response`.
- [x] Register the function in `supabase/config.toml` with `enabled = true`, `verify_jwt = false`, its `import_map` and `entrypoint`, matching the `validate-access` block.
- [x] In `index.ts`: wrap in `withSupabase({ auth: "none" }, …)` — the documented shape for a signed webhook, and the only one that works for a caller with no Supabase credentials. Reject non-`POST`. Read `NOTIFY_HOOK_SECRET`; if unset, `500` with `{ error: "config" }`. Compare it to the `x-khata-hook` header by SHA-256 digest and an XOR-accumulating loop, so neither content nor length leaks through timing; mismatch → bare `401`.
- [x] ~~Branch on `body.action === "install-hook"`~~ — **removed**. Authenticating the install with the secret being installed can never converge (the running function is always one value behind, and answers 401). The Vault writing lives in a `security definer` function granted to `service_role` alone, which `npm run config` now calls directly as a PostgREST RPC. The edge function is only ever a recipient.
- [x] Default branch — the hook. Parse `body.log`. Run it through the text composer; a `null` result means nothing to send, return `{ ok: true, sent: 0 }`.
- [x] Import the composer from `../_shared/notifyText.ts` — a relative import, exactly as `rateLimit.ts` is imported. No hand-mirroring (see Task 2).
- [x] Load subscriptions with the service-role client: `select * from push_subscriptions where user_name <> log.actor`.
- [x] Import the VAPID keys once per invocation and build the application server. The library stores a keypair as **JWK**, so this is one secret, `VAPID_KEYS`, holding `{publicKey, privateKey}` — not two base64url strings — plus `VAPID_SUBJECT`. Send to every subscription **concurrently** via `Promise.allSettled` — a slow push service must not serialise the fan-out.
- [x] The payload is JSON: `{ title, body, tag }`. No `url` — the service worker derives it from its own registration scope, which is one less thing to configure per deployment. Well under 4 KB.
- [x] On a `404` or `410` response, delete that `endpoint` row. Any other failure: `console.error` and move on. Never throw out of the handler — the trigger has already forgotten about this request, so a 500 helps nobody.
- [x] Return `{ ok: true, sent, pruned }`.

**Verify:** `deno check` needs `jsr.io`, which this environment cannot reach, so the file was parse-checked with esbuild and its composer covered by the 27 vitest cases. The `install_notify_hook` half is covered by the SQL harness (permission denied for `authenticated`, both rows written, re-run does not duplicate, rotation replaces in place). The send path itself is only proven by Task 6.

---

### Task 4: The browser side

**Files:**

- Create: `public/push-sw.js`, `src/lib/push.ts`, `src/lib/push.test.ts`, `src/lib/pushSw.test.ts`, `src/lib/platform.ts`, `src/hooks/usePushNotifications.ts`, `src/components/NotifyPrompt.tsx`
- Modify: `vite.config.ts`, `src/lib/db.ts`, `src/App.tsx`, `src/components/PeopleSheet.tsx`, `src/components/icons.tsx`, `src/hooks/useInstallPrompt.ts`, `src/styles.css`, `src/vite-env.d.ts`, `.env.example`

**Steps:**

- [x] `public/push-sw.js` — a `push` listener calling `event.waitUntil(self.registration.showNotification(...))` with `tag`, `icon: "pwa-192x192.png"`, `badge`, and `data: { url }`. A payload that fails to parse still shows a generic card: `userVisibleOnly: true` means a silent push costs the site its permission.
- [x] The same file: `notificationclick` → `notification.close()`, then match `self.clients.matchAll({ type: "window", includeUncontrolled: true })` and `focus()` an existing client on the app's scope, else `clients.openWindow(url)`.
- [x] `vite.config.ts` — add `importScripts: ["push-sw.js"]` inside the existing `workbox` block. Leave `globPatterns` and `runtimeCaching` untouched; the new file is already matched by `**/*.{js,...}` and gets precached.
- [x] `src/vite-env.d.ts` — `readonly VITE_VAPID_PUBLIC_KEY?: string;` (optional: builds without it must still succeed, with notifications simply unavailable). Document it in `.env.example` next to the note explaining why the anon key is public.
- [x] `src/lib/push.ts`:
  - `pushSupported()`, `configured()`, `permission()`.
  - `needsHomeScreen()` — iOS and not standalone. `isIos`/`isStandalone` were lifted out of `src/hooks/useInstallPrompt.ts` into a new `src/lib/platform.ts` that both import, rather than a second copy.
  - `subscribe()` drops and remakes a subscription whose `applicationServerKey` differs from the current one, so rotating the VAPID keypair does not mean asking everyone to clear site data.
  - `registration()` races `navigator.serviceWorker.ready` against a timeout: `ready` never settles when no worker is registered, which is the case under `npm run dev`.
  - `urlBase64ToUint8Array(base64)` — the standard VAPID key decoder.
  - `getSubscription()`, `subscribe()`, `unsubscribe()` over `navigator.serviceWorker.ready`.
- [x] `src/lib/db.ts` — `savePushSubscription(sub, userName, deviceId)` and `deletePushSubscription(endpoint)`. Save is an `insert`, falling back to an `update ... eq("endpoint")` when the insert returns `23505`; **not** `.upsert()`, which needs table-wide select privilege. Both follow the module's existing `fail(context, error)` convention, and neither chains `.select()` (§Global Constraints).
- [x] `src/hooks/usePushNotifications.ts` — exposes `{ supported, needsHomeScreen, permission, enabled, busy, enable, disable }`, plus `dismissed`/`dismiss` against `localStorage` key `khata.notifyDismissed`, mirroring `useInstallPrompt`'s shape and its try/catch-around-every-storage-access discipline.
- [x] `enable()` must call `Notification.requestPermission()` synchronously inside the click handler's call stack — no `await` before it, or Safari drops the user gesture.
- [x] `src/components/NotifyPrompt.tsx` — the card. Two states, per spec §6.2. Reuse the `.install*` CSS class language with `.notify*` equivalents; add `IcBell` / `IcBellOff` to `icons.tsx` in the existing style.
- [x] `src/components/PeopleSheet.tsx` — a "This device" section above the people list holding the permanent toggle. It is device state, not person state, so it does not belong in a person's row.
- [x] `src/App.tsx` — render `<NotifyPrompt />` next to `<InstallPrompt />`. In `handleGateSubmit`, after `signIn(clean)`, fire-and-forget a rebind of any existing subscription to the new name (`.catch(() => {})`, exactly like the neighbouring `db.logLogin`). In `handleSignOut`, unsubscribe and delete the row before clearing the name.
- [x] `src/lib/push.test.ts` — 15 cases: `urlBase64ToUint8Array` decodes a 65-byte P-256 point, restores stripped padding and translates the url-safe alphabet; the capability matrix with `serviceWorker`/`PushManager`/`Notification` each absent; iPhone tab vs Home Screen, iPadOS-reporting-as-a-Mac vs a real Mac, and Android either way.
- [x] `src/lib/pushSw.test.ts` — 9 cases running `public/push-sw.js` against a fake `self`: the composed text reaches `showNotification`, the tag survives three sends of a Settle All, `renotify` stays off, an unparseable payload still shows a card, click focuses an already-open window, ignores an unrelated one on the same origin, and otherwise opens the app at its own scope.

**Verify:** done — lint, typecheck, 326 tests and `npm run build` all clean, and the built `dist/sw.js` was inspected to confirm it carries `importScripts("push-sw.js")` with `dist/push-sw.js` alongside it. Still to do by hand: `npm run dev` over HTTPS (the repo already allows `.ngrok-free.app` hosts for exactly this) to confirm a real subscription lands in the table.

---

### Task 5: Setup and deploy wiring

**Files:**

- Create: `scripts/config/vapid.mjs`, `scripts/config/vapid.test.mjs`
- Modify: `scripts/config/registry.mjs`, `scripts/config/validate.mjs`, `scripts/config/validate.test.mjs`, `scripts/config.mjs`, `.github/workflows/deploy.yml`, `README.md`

**Steps:**

- [x] `scripts/config/vapid.mjs` — `generateVapidKeys()` using `crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })`. Returns the JWK pair the sender imports **and** the 65-byte uncompressed point the browser subscribes with, derived from the public JWK's `x`/`y`. No dependencies. Also `randomSecret()` for the hook secret.
- [x] `scripts/config/validate.mjs` — `vapidPublicKey` (base64url decoding to 65 bytes, first byte `0x04`), `vapidKeys` (a JWK pair, rejecting a public half that carries `d`), `contactUri` for the subject, `hookSecret` (min length, no spaces). 24 tests alongside the existing validator ones.
- [x] `scripts/config/registry.mjs` — the four settings from spec §3.11, and a `WIZARD_STEPS` entry: `{ n: 6, title: "Turn on push notifications (optional)" }`. Three are `wizard: { step: 6, required: false }` — notifications are opt-in for the whole deployment. `vapid-keys` is `wizard: null`, since a JWK pair is never typed by hand; a registry test enforces that only a setting some generator fills may opt out of the wizard. `runWizard` needed `s.wizard?.step` to allow that.
- [x] Extend the registry model with an optional `generate()` on a setting, returning `{ [settingId]: value }` for **one or more** settings. `vapid-public-key` carries it and returns both halves of the keypair. Document the new field in the registry's header comment beside `obtain`, since spec §3.3 of the config-script design describes the setting shape and this adds to it.
- [x] `scripts/config.mjs` — `offerGenerate` runs before the obtain/prompt path, applies every id the generator returns, and validates each through its own validator on the way, so a bad generator fails at setup rather than silently on a phone.
- [x] `installNotifyHook` POSTs to `/rest/v1/rpc/install_notify_hook` with the project's service key, obtained from `supabase projects api-keys` so the CLI's own credential store is never touched. A warning, never fatal, and every failure names the command that fixes it (`supabase login`, `supabase link`, deploy the migration). Pure helpers in `scripts/config/hook.mjs` with 23 tests.
- [x] `deploy.yml` — add `supabase functions deploy notify --use-api --yes` beside the other two, and `VITE_VAPID_PUBLIC_KEY: ${{ secrets.VITE_VAPID_PUBLIC_KEY }}` to the build step's `env`. Do **not** add it to the secret-presence gate: a deployment without notifications must keep working.
- [x] `README.md` — a Notifications section after Splitwise: what fires (adds and settles, not edits), that the actor is skipped, that amounts are never shown, **that iPhones must add the app to the Home Screen first**, and how to turn the whole thing off (delete the two Vault rows).

**Verify:** done — 365 tests, lint, typecheck and format all clean. `vapid.test.mjs` runs the generated keys through the exact WebCrypto calls `@negrel/webpush` makes: both halves import, they sign and verify as a pair, and WebCrypto's own `exportKey("raw")` matches the derived application server key — so the shape is right before anything is deployed. A build with a real key was checked to carry it in the bundle. Still to do: a `workflow_dispatch` run of the deploy once merged.

---

### Task 6: End-to-end verification

Not automatable, and the only thing that actually proves the feature works.

- [ ] Android Chrome, installed: enable, have a second device add an entry, confirm the notification arrives with the app **fully closed**.
- [ ] iPhone: confirm the banner shows the Home Screen steps and no permission prompt in a Safari tab; add to Home Screen; confirm the prompt then appears and a notification arrives.
- [ ] Actor skipping: add an entry and confirm the adding device gets nothing.
- [ ] Settle All across three weeks: confirm **one** visible notification, not three.
- [ ] Tap a notification with the app closed → opens the ledger. With the app open in the background → focuses the existing window, no second tab.
- [ ] Turn notifications off on one device; add an entry; confirm that device is silent and the row is gone from `push_subscriptions`.
- [ ] Sign out and sign back in as a different name on the same device; confirm the notification for an entry by that new name is now skipped, and one by the old name arrives.
- [ ] With the Vault rows deleted, confirm adds and settles still work and nothing errors — the inert path from spec §9.

## Open risks

1. **`jsr:@negrel/webpush` version and API.** Pinned from the spec's research, not from a build. Confirm against JSR at Task 3 and fall back to `npm:web-push` if the Deno import misbehaves under Supabase's edge runtime — the function's shape does not change either way.
2. **`workbox.importScripts` under `vite-plugin-pwa` 1.3.** Confirmed as a pass-through to `workbox-build`'s `generateSW`, but the first `npm run build` of Task 4 is where it is actually proven. If it disappoints, the fallback is `strategies: "injectManifest"` with a hand-written `src/sw.ts` that re-creates today's precache and Google Fonts rules — a larger change, which is exactly why it was not the first choice.
3. **`vault.create_secret` from the edge function.** If the service role cannot write Vault on this project's plan, drop `install-hook` and ship only the documented SQL snippet; nothing else in the design moves.
4. **iOS silently ignoring a subscription.** Historically the most fragile leg. Task 6 has to be done on a real iPhone, not a simulator.
