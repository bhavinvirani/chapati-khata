-- The guest bucket: chapatis nobody on the list claimed.
--
-- Its cost is absorbed by the people who did eat, folded into their
-- entry_shares.amount — so the money invariant is unchanged and entries.amount
-- still equals the sum of its shares. Only the count sits outside the shares,
-- which moves the qty invariant to
--   entries.qty = sum(entry_shares.qty) + entries.other_qty
-- and `needsRepair` in src/lib/aggregate.ts knows that.
--
-- Defaults to 0, so every existing add keeps satisfying the invariant untouched.
alter table public.entries
  add column if not exists other_qty integer not null default 0 check (other_qty >= 0);
