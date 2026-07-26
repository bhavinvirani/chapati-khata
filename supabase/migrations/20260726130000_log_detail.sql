-- What actually changed, in words, on the log row.
--
-- The log carried quantities only, so an edit that moved the rate, the guest
-- bucket, or the allocation between people while leaving the total alone
-- rendered as a bare "edited Wed Jul 15". Composed at write time in
-- src/lib/logtext.ts, where the people who existed then can still be named.
alter table public.logs add column if not exists detail text;
