-- ============================================================
-- Chapati Khata — run this once in Supabase → SQL Editor.
-- Creates the tables, the light-gate access rules, and realtime.
-- ============================================================

create extension if not exists pgcrypto;

-- One row per Monday–Sunday week. Its paid flag is the source of truth.
create table if not exists public.weeks (
  week_start date primary key,
  paid       boolean     not null default false,
  paid_at    timestamptz
);

-- One row per ADD. Several adds may share a day, each with its own rate.
create table if not exists public.entries (
  id         uuid         primary key default gen_random_uuid(),
  week_start date         not null references public.weeks(week_start) on delete cascade,
  day        date         not null,
  qty        integer      not null check (qty > 0),   -- = sum(shares.qty) + other_qty
  rate       numeric(10,4) not null check (rate > 0), -- price per chapati for this add
  other_qty  integer      not null default 0 check (other_qty >= 0), -- guests; cost shared by those who ate
  amount     numeric(10,2) not null,                  -- = sum of this add's share amounts
  note       text         not null default '',
  created_at timestamptz  not null default now()
);
create index if not exists entries_week_idx on public.entries(week_start);
create index if not exists entries_day_idx  on public.entries(day);

-- ── people ──
create table if not exists public.users (
  id         uuid    primary key default gen_random_uuid(),
  name       text    not null unique,        -- lowercase, trimmed
  in_split   boolean not null default true,  -- offered in the split composer
  can_login  boolean not null default true,  -- passes the gate
  created_at timestamptz not null default now()
);

-- ── settlements: one row per Mark Paid / Settle All click, whatever weeks
-- it covers — the pushable unit for the Splitwise integration. ──
create table if not exists public.settlements (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  actor                   text not null,
  device_id               text,
  splitwise_payer_user_id uuid references public.users(id) on delete restrict,
  splitwise_expense_id    text,
  splitwise_status        text check (splitwise_status in ('unknown')),
  splitwise_pushed_at     timestamptz
);

alter table public.weeks
  add column if not exists settlement_id uuid references public.settlements(id) on delete restrict;
create index if not exists weeks_settlement_idx on public.weeks(settlement_id);

alter table public.users add column if not exists splitwise_email   text;
alter table public.users add column if not exists splitwise_user_id text;

-- ── the per-person breakdown ──
-- on delete restrict is the teeth behind "a person with history cannot be
-- deleted"; on delete cascade means removing an add takes its shares with it.
create table if not exists public.entry_shares (
  entry_id uuid    not null references public.entries(id) on delete cascade,
  user_id  uuid    not null references public.users(id)   on delete restrict,
  qty      integer not null check (qty >= 0), -- 0 when they only cover guests
  amount   numeric(10,2) not null,
  primary key (entry_id, user_id)
);
create index if not exists entry_shares_user_idx on public.entry_shares(user_id);

-- Append-only change history. actor + device_id are stored but not shown in the UI.
create table if not exists public.logs (
  id          uuid        primary key default gen_random_uuid(),
  ts          timestamptz not null default now(),
  actor       text        not null,
  action      text        not null,        -- create | add | edit | delete | paid | reopen
  week_start  date,
  day         date,
  qty_before  integer,
  qty_after   integer,
  note_before text,
  note_after  text,
  target      text,
  detail      text,        -- what changed, in words (see src/lib/logtext.ts)       -- the person a user_* action refers to
  device_id   text
);
create index if not exists logs_ts_idx on public.logs(ts desc);

-- ── Light gate: only an authenticated session (incl. anonymous sign-in) may
-- read or write. A bare anon key with no session is rejected. This keeps out
-- random internet scanners; it is not fortress-grade, by design. ──
alter table public.weeks        enable row level security;
alter table public.entries      enable row level security;
alter table public.logs         enable row level security;
alter table public.users        enable row level security;
alter table public.entry_shares enable row level security;

drop policy if exists "authed all - weeks"        on public.weeks;
drop policy if exists "authed all - entries"      on public.entries;
drop policy if exists "authed all - logs"         on public.logs;
drop policy if exists "authed all - users"        on public.users;
drop policy if exists "authed all - entry_shares" on public.entry_shares;
drop policy if exists "authed all - settlements"  on public.settlements;

create policy "authed all - weeks"        on public.weeks        for all to authenticated using (true) with check (true);
create policy "authed all - entries"      on public.entries      for all to authenticated using (true) with check (true);
create policy "authed all - logs"         on public.logs         for all to authenticated using (true) with check (true);
create policy "authed all - users"        on public.users        for all to authenticated using (true) with check (true);
create policy "authed all - entry_shares" on public.entry_shares for all to authenticated using (true) with check (true);
create policy "authed all - settlements"  on public.settlements for all to authenticated using (true) with check (true);

-- RLS policies only take effect once the role also holds the table-level
-- grant; without this, queries fail with "permission denied for table ...".
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.weeks, public.entries, public.logs,
  public.users, public.entry_shares, public.settlements to authenticated;

-- The gate's edge function reads this table with the service-role key, before
-- any session exists for RLS to authorise against. This project revoked the
-- public schema's PUBLIC usage, so that access needs saying out loud.
grant usage on schema public to service_role;
grant select on public.users to service_role;

-- ── Rate limiting: backing table for validate-access and splitwise's
-- throttling, since a stateless edge function has nowhere else to remember
-- attempts between requests. Accessed only via the service-role key — no
-- policy grants authenticated/anon access, on purpose. ──
create table if not exists public.rate_limit_attempts (
  id         uuid primary key default gen_random_uuid(),
  bucket     text not null,        -- which check this belongs to, e.g. 'validate-access'
  key        text not null,        -- what's being limited, e.g. the caller's IP
  created_at timestamptz not null default now()
);
create index if not exists rate_limit_attempts_lookup_idx on public.rate_limit_attempts(bucket, key, created_at);
alter table public.rate_limit_attempts enable row level security;
grant select, insert, delete on public.rate_limit_attempts to service_role;

-- ── Push notifications: one row per subscribed browser, plus the trigger that
-- tells the `notify` edge function to fan a new add or settlement out to
-- everyone else's phone. Inert until the two Vault secrets at the bottom of
-- this block exist. ──
create extension if not exists pg_net;

create table if not exists public.push_subscriptions (
  endpoint     text primary key,       -- the push service URL; identity of a device
  p256dh       text not null,          -- client public key    ┐ RFC 8291
  auth         text not null,          -- client auth secret   ┘ encryption inputs
  user_name    text not null,          -- the name typed at the gate when it subscribed
  device_id    text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_name);
alter table public.push_subscriptions enable row level security;

-- Same "authed all" policy shape as every other table here. What differs is
-- the grant: on this table the confidentiality boundary is column privileges,
-- not row visibility. p256dh and auth are the key material for messaging
-- somebody's phone and the anon key ships in the frontend, so `select *` is
-- refused by Postgres before RLS is consulted. The sender reads them with the
-- service-role key, which bypasses RLS, exactly as rate_limit_attempts is.
drop policy if exists "authed all - push_subscriptions" on public.push_subscriptions;
create policy "authed all - push_subscriptions" on public.push_subscriptions for all to authenticated using (true) with check (true);

grant insert, update, delete on public.push_subscriptions to authenticated;
grant select (endpoint, user_name, device_id, created_at, last_seen_at)
  on public.push_subscriptions to authenticated;

create or replace function public.notify_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $notify_push$
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
  -- worker, so the enclosing insert never waits on a push service.
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
  -- A notification is a nicety; the log row it hangs off is the record.
  -- Anything that goes wrong in here must degrade to silence rather than
  -- abort the insert and stop somebody logging chapatis.
  when others then
    return null;
end;
$notify_push$;

revoke execute on function public.notify_push() from public;
revoke execute on function public.notify_push() from anon, authenticated;

-- Writes the two rows notify_push() reads. Exists because the `vault` schema
-- is not exposed through PostgREST, so the setup wizard hands the values to
-- the `notify` edge function, which calls this with its service-role client.
create or replace function public.install_notify_hook(hook_secret text, function_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $install_notify_hook$
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
$install_notify_hook$;

revoke execute on function public.install_notify_hook(text, text) from public;
revoke execute on function public.install_notify_hook(text, text) from anon, authenticated;
grant execute on function public.install_notify_hook(text, text) to service_role;

drop trigger if exists logs_notify_push on public.logs;
create trigger logs_notify_push
  after insert on public.logs
  for each row
  when (new.action in ('create', 'paid'))
  execute function public.notify_push();

-- The two secrets the trigger reads. Set them once, either through
-- `npm run config` or by hand:
--   select vault.create_secret('<random string>', 'notify_hook_secret');
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/notify', 'notify_function_url');
-- Deleting both rows turns push notifications off without touching this schema.

-- ── Realtime so every device sees changes instantly ──
-- Guarded because `alter publication ... add table` has no `if not exists`
-- form and errors ("already member of publication") on a second run.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'weeks'
  ) then
    alter publication supabase_realtime add table public.weeks;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'entries'
  ) then
    alter publication supabase_realtime add table public.entries;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'logs'
  ) then
    alter publication supabase_realtime add table public.logs;
  end if;
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
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'settlements'
  ) then
    alter publication supabase_realtime add table public.settlements;
  end if;
end $$;
