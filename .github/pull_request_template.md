## What does this change?

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run test` pass locally
- [ ] Added or updated tests for the behaviour I changed (or said below why not)
- [ ] All Supabase access still goes through `src/lib/db.ts` — no `supabase.from(...)` in components or hooks
- [ ] Group-specific values (names, price, currency) are still confined to `src/config.ts`
- [ ] Every mutation still writes an audit row via `logAction` in `src/lib/db.ts`
- [ ] Money still goes through `round2` / `money` from `src/lib/util.ts`
- [ ] Week ids are still the local-time Monday from `weekIdOf`
- [ ] No new secrets in the client bundle — the anon key is public by design, the service-role key never is
- [ ] Access-code validation still lives in `supabase/functions/validate-access`; `VITE_ENTRY_CODE` stays dev-only

## Notes for reviewers

<!-- Anything you want a second pair of eyes on. Screenshots for UI changes. -->
