-- Neither edge function had any throttling: validate-access's 4-digit code
-- was checkable at unlimited speed, and splitwise's "link" action let any
-- session (trivial to get anonymously — see the design doc's §4.10) probe
-- arbitrary emails against real group membership at unlimited speed too.
--
-- Backing table for both, since Deno edge functions are stateless between
-- requests — the attempt count has to live somewhere that survives across
-- invocations. Accessed exclusively by the edge functions via the
-- service-role key, which bypasses RLS entirely — no policy grants
-- authenticated/anon access, on purpose, since regular sessions should never
-- see rate-limit bookkeeping.
create table public.rate_limit_attempts (
  id         uuid primary key default gen_random_uuid(),
  bucket     text not null,        -- which check this belongs to, e.g. 'validate-access'
  key        text not null,        -- what's being limited, e.g. the caller's IP
  created_at timestamptz not null default now()
);
create index rate_limit_attempts_lookup_idx on public.rate_limit_attempts(bucket, key, created_at);

alter table public.rate_limit_attempts enable row level security;

grant usage on schema public to service_role;
grant select, insert, delete on public.rate_limit_attempts to service_role;
