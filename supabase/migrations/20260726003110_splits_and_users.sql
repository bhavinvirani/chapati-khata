-- Per-person splits and DB-backed user management.
--
-- entries goes from one row per day to one row per ADD, each carrying its own
-- rate, with a child entry_shares table holding the per-person breakdown.
-- users replaces allowed-names.json as the login allowlist.

-- ── people ──
create table if not exists public.users (
  id         uuid    primary key default gen_random_uuid(),
  name       text    not null unique,        -- lowercase, trimmed
  in_split   boolean not null default true,  -- offered in the split composer
  can_login  boolean not null default true,  -- passes the gate
  created_at timestamptz not null default now()
);

-- Seed from the allowed-names.json list this migration retires. Written
-- literally because SQL cannot read a repo file, and the file is deleted in
-- this same change.
insert into public.users (name)
values ('bhavin'), ('abhishek'), ('deven'), ('parth'), ('pratik'), ('hitanshi'), ('samir')
on conflict (name) do nothing;

-- ── one row per add, not per day ──
-- No backfill. This is a fresh start: the release wipes every row before this
-- runs, so there is no legacy row whose real rate anyone could know. Against a
-- non-empty table this fails immediately with "column rate contains null
-- values" — loudly, rather than inventing a rate nobody can verify. That is
-- the intended behaviour, not an oversight.
alter table public.entries add column rate numeric(10,4) not null check (rate > 0);

-- Several adds may now share a date. Not matched by the CI destructive-SQL
-- guard, which looks for drop table/column/schema/extension — not constraints.
alter table public.entries drop constraint if exists entries_day_key;
create index if not exists entries_day_idx on public.entries(day);

-- ── the per-person breakdown ──
-- on delete restrict is the teeth behind "a person with history cannot be
-- deleted"; on delete cascade means removing an add takes its shares with it.
create table if not exists public.entry_shares (
  entry_id uuid    not null references public.entries(id) on delete cascade,
  user_id  uuid    not null references public.users(id)   on delete restrict,
  qty      integer not null check (qty > 0),
  amount   numeric(10,2) not null,
  primary key (entry_id, user_id)
);
create index if not exists entry_shares_user_idx on public.entry_shares(user_id);

-- ── the person a user_* log action refers to ──
alter table public.logs add column if not exists target text;

-- ── same light gate as the other tables ──
alter table public.users        enable row level security;
alter table public.entry_shares enable row level security;

drop policy if exists "authed all - users"         on public.users;
drop policy if exists "authed all - entry_shares"  on public.entry_shares;

create policy "authed all - users"        on public.users        for all to authenticated using (true) with check (true);
create policy "authed all - entry_shares" on public.entry_shares for all to authenticated using (true) with check (true);

-- RLS only takes effect once the role also holds the table-level grant;
-- without this, queries fail with "permission denied for table ...".
grant select, insert, update, delete on public.users, public.entry_shares to authenticated;

-- The gate's edge function reads this table with the service-role key, before
-- any session exists for RLS to authorise against. This project revoked the
-- public schema's PUBLIC usage, so that access needs saying out loud.
grant usage on schema public to service_role;
grant select on public.users to service_role;

-- ── realtime ──
-- Guarded because `alter publication ... add table` has no `if not exists`
-- form and errors on a second run.
do $$
begin
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
end $$;
