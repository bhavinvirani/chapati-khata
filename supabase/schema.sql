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
drop policy if exists "authed all - settlements" on public.settlements;

create policy "authed all - weeks"        on public.weeks        for all to authenticated using (true) with check (true);
create policy "authed all - entries"      on public.entries      for all to authenticated using (true) with check (true);
create policy "authed all - logs"         on public.logs         for all to authenticated using (true) with check (true);
create policy "authed all - users"        on public.users        for all to authenticated using (true) with check (true);
create policy "authed all - entry_shares" on public.entry_shares for all to authenticated using (true) with check (true);
create policy "authed all - settlements" on public.settlements for all to authenticated using (true) with check (true);

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
