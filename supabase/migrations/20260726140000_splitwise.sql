-- Splitwise integration: a settlement groups whichever week(s) were paid
-- together in one Mark Paid / Settle All click, and becomes the pushable
-- unit — one Splitwise expense per settlement, however many weeks it
-- covers. See docs/superpowers/specs/2026-07-26-splitwise-integration-design.md.

create table public.settlements (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  actor                   text not null,
  device_id               text,
  -- restrict, not cascade: a settlement is a real record of who fronted
  -- money, and "a person with history cannot be deleted" should hold here
  -- the same way it holds for entry_shares.
  splitwise_payer_user_id uuid references public.users(id) on delete restrict,
  splitwise_expense_id    text,
  -- null means "never pushed, or last attempt failed cleanly"; 'unknown'
  -- means the last attempt's outcome couldn't be determined (e.g. a
  -- timeout) and a silent retry is not safe.
  splitwise_status        text check (splitwise_status in ('unknown')),
  splitwise_pushed_at     timestamptz
);

alter table public.weeks
  add column settlement_id uuid references public.settlements(id) on delete restrict;
create index weeks_settlement_idx on public.weeks(settlement_id);

alter table public.users add column splitwise_email   text;
alter table public.users add column splitwise_user_id text;

alter table public.settlements enable row level security;
create policy "authed all - settlements" on public.settlements
  for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.settlements to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'settlements'
  ) then
    alter publication supabase_realtime add table public.settlements;
  end if;
end $$;
