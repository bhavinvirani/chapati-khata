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

-- One row per day (day is unique — enforces "one entry per day" in the DB).
create table if not exists public.entries (
  id         uuid         primary key default gen_random_uuid(),
  week_start date         not null references public.weeks(week_start) on delete cascade,
  day        date         not null unique,
  qty        integer      not null check (qty > 0),
  amount     numeric(10,2) not null,        -- money for the day, fixed at logging time
  note       text         not null default '',
  created_at timestamptz  not null default now()
);
create index if not exists entries_week_idx on public.entries(week_start);

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
  device_id   text
);
create index if not exists logs_ts_idx on public.logs(ts desc);

-- ── Light gate: only an authenticated session (incl. anonymous sign-in) may
-- read or write. A bare anon key with no session is rejected. This keeps out
-- random internet scanners; it is not fortress-grade, by design. ──
alter table public.weeks   enable row level security;
alter table public.entries enable row level security;
alter table public.logs    enable row level security;

drop policy if exists "authed all - weeks"   on public.weeks;
drop policy if exists "authed all - entries" on public.entries;
drop policy if exists "authed all - logs"    on public.logs;

create policy "authed all - weeks"   on public.weeks   for all to authenticated using (true) with check (true);
create policy "authed all - entries" on public.entries for all to authenticated using (true) with check (true);
create policy "authed all - logs"    on public.logs    for all to authenticated using (true) with check (true);

-- RLS policies only take effect once the role also holds the table-level
-- grant; without this, queries fail with "permission denied for table ...".
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.weeks, public.entries, public.logs to authenticated;

-- ── Realtime so every device sees changes instantly ──
alter publication supabase_realtime add table public.weeks;
alter publication supabase_realtime add table public.entries;
alter publication supabase_realtime add table public.logs;
