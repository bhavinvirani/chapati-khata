-- Push notifications: tell everyone else's phone when someone logs an add or
-- settles a week. See docs/superpowers/specs/2026-08-17-push-notifications-design.md.
--
-- Nothing here is reachable until the two Vault secrets below exist, so this
-- migration is inert on a project that hasn't been configured for push yet
-- (design §9) — the app behaves exactly as it did before.

-- Async HTTP from inside a trigger. pg_net creates its own `net` schema; it is
-- not relocatable, so no `with schema` clause here.
create extension if not exists pg_net;

-- ── one row per subscribed browser ──
-- `endpoint` is the push service's URL for this device, and the browser
-- already treats it as the subscription's identity — so it is the primary key,
-- and re-subscribing is an insert that may conflict. Deliberately not written
-- as `on conflict do update`: that form requires table-wide select privilege,
-- which would undo the column grants below. src/lib/db.ts inserts and falls
-- back to an update on 23505.
create table public.push_subscriptions (
  endpoint     text primary key,
  -- The RFC 8291 encryption inputs. Anyone holding these can send a
  -- notification to this device, which is why the frontend can never read
  -- them back (see the grants below).
  p256dh       text not null,
  auth         text not null,
  -- The name typed at the gate when this device subscribed. Not identity —
  -- the same label the rest of the app already trusts — but it is what lets
  -- the sender skip whoever caused the event.
  user_name    text not null,
  device_id    text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_name);

alter table public.push_subscriptions enable row level security;

-- The RLS policy is the same "authed all" shape as every other table here.
-- What is different is the grant below: on this table the confidentiality
-- boundary is column privileges, not row visibility.
create policy "authed all - push_subscriptions" on public.push_subscriptions
  for all to authenticated using (true) with check (true);

grant insert, update, delete on public.push_subscriptions to authenticated;
-- Every column EXCEPT p256dh and auth. Those two are the key material for
-- messaging somebody's phone, and the anon key ships in the frontend for
-- anyone to read — so a session can manage subscriptions but `select *` (and
-- any read naming either column) is refused by Postgres itself, before RLS is
-- even consulted. The sender reads them with the service-role key, which
-- bypasses RLS, exactly as rate_limit_attempts is read.
--
-- Row visibility is deliberately NOT the mechanism: without a select policy,
-- `update`/`delete ... where endpoint = ?` cannot locate the row and silently
-- affect zero rows, which would leave a device unable to re-subscribe or
-- unsubscribe.
grant select (endpoint, user_name, device_id, created_at, last_seen_at)
  on public.push_subscriptions to authenticated;

-- ── the trigger ──
-- Reads its configuration from Vault rather than hardcoding it: the function
-- URL carries the project ref, and this repo is meant to be forked and pointed
-- at somebody else's Supabase project.
create or replace function public.notify_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook_secret text;
  fn_url      text;
begin
  select decrypted_secret into hook_secret
    from vault.decrypted_secrets where name = 'notify_hook_secret';
  select decrypted_secret into fn_url
    from vault.decrypted_secrets where name = 'notify_function_url';

  -- Not configured for push yet. Silence, not an error.
  if hook_secret is null or fn_url is null then
    return null;
  end if;

  -- Fire-and-forget: net.http_post only queues a row for pg_net's background
  -- worker, so the enclosing insert is never waiting on a push service.
  perform net.http_post(
    url := fn_url,
    body := jsonb_build_object('log', to_jsonb(new)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-khata-hook', hook_secret
    ),
    timeout_milliseconds := 5000
  );

  return null;
exception
  -- The single most important line in this migration. A notification is a
  -- nicety; the log row it hangs off is the record. Anything that goes wrong
  -- in here — a missing Vault row, pg_net not installed, a malformed URL —
  -- must degrade to silence rather than abort the insert and stop somebody
  -- logging chapatis.
  when others then
    return null;
end;
$$;

-- A security definer function that can read Vault must not be callable
-- directly by a session; only the trigger should ever reach it.
revoke execute on function public.notify_push() from public;
revoke execute on function public.notify_push() from anon, authenticated;

-- ── the bootstrap ──
-- Writes the two rows notify_push() reads. It exists because the `vault`
-- schema is not exposed through PostgREST, so the setup wizard cannot write
-- those rows directly — it hands the values to the `notify` edge function,
-- which calls this with its service-role client.
--
-- Idempotent: re-running `npm run config`, or rotating the secret, updates in
-- place rather than piling up duplicate names.
create or replace function public.install_notify_hook(hook_secret text, function_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  sid uuid;
begin
  select id into sid from vault.secrets where name = 'notify_hook_secret';
  if sid is null then
    perform vault.create_secret(hook_secret, 'notify_hook_secret',
      'Shared secret the logs trigger presents to the notify edge function');
  else
    perform vault.update_secret(sid, hook_secret);
  end if;

  select id into sid from vault.secrets where name = 'notify_function_url';
  if sid is null then
    perform vault.create_secret(function_url, 'notify_function_url',
      'URL of the notify edge function the logs trigger posts to');
  else
    perform vault.update_secret(sid, function_url);
  end if;
end;
$$;

-- Only the sender, holding the service-role key, may install the hook.
revoke execute on function public.install_notify_hook(text, text) from public;
revoke execute on function public.install_notify_hook(text, text) from anon, authenticated;
grant execute on function public.install_notify_hook(text, text) to service_role;

-- `create` is a new add, `paid` is a settlement. Edits, deletes, reopens,
-- Splitwise bookkeeping, logins and people changes stay silent (design §3.3).
create trigger logs_notify_push
  after insert on public.logs
  for each row
  when (new.action in ('create', 'paid'))
  execute function public.notify_push();
