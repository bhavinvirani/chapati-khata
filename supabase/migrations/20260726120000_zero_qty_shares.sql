-- Allow a share row with a count of 0 but real money on it.
--
-- The guest bucket's cost is shared by a chosen set of people, which may
-- include someone who took no chapatis themselves — and an add may be guests
-- only, with nobody taking a personal count at all. Those people still owe
-- their slice, so they need a row; `qty > 0` made that impossible.
--
-- "Who was in this add" is now "rows present" rather than "rows with a count",
-- which is the same rule stated one level up. A row with neither a count nor
-- money is still never written.
--
-- Not matched by the CI destructive-SQL guard: this drops a CHECK constraint,
-- not a table, column, schema or extension.
alter table public.entry_shares drop constraint if exists entry_shares_qty_check;
alter table public.entry_shares add constraint entry_shares_qty_check check (qty >= 0);
