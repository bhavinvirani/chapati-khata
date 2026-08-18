-- A nudge at 8:30pm on days nobody has logged anything yet.
--
-- Scheduled in the database rather than from a GitHub Action: the hook secret
-- already lives in Vault, and Actions cron is routinely ten or more minutes
-- late, which is not what "8:30" means to a person waiting for it.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

/**
 * Fire the reminder, if this is the hour and the day is still empty.
 *
 * The job runs every hour at :30 and this returns immediately for twenty-three
 * of them. That is deliberate: pg_cron schedules are UTC, and a fixed UTC hour
 * drifts by one twice a year when the group's clocks change. Checking the
 * local hour instead is self-correcting and costs twenty-three trivial
 * queries a day.
 */
create or replace function public.notify_reminder()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook_secret text;
  fn_url      text;
  tz          text;
  at_hour     int;
  local_now   timestamp;
begin
  select decrypted_secret into hook_secret
    from vault.decrypted_secrets where name = 'notify_hook_secret';
  select decrypted_secret into fn_url
    from vault.decrypted_secrets where name = 'notify_function_url';

  -- Not configured for push at all. Silence, exactly as notify_push does.
  if hook_secret is null or fn_url is null then
    return;
  end if;

  -- Both overridable with one insert into Vault, so moving the reminder or
  -- forking this for a group in another timezone needs no migration:
  --   select vault.create_secret('Europe/London', 'notify_reminder_tz');
  --   select vault.create_secret('19',            'notify_reminder_hour');
  tz := coalesce(
    (select decrypted_secret from vault.decrypted_secrets where name = 'notify_reminder_tz'),
    'America/Toronto');
  at_hour := coalesce(
    (select decrypted_secret from vault.decrypted_secrets where name = 'notify_reminder_hour'),
    '20')::int;

  local_now := now() at time zone tz;
  if extract(hour from local_now)::int <> at_hour then
    return;
  end if;

  -- Nothing to nag about once the day is in the book. This is what keeps the
  -- reminder a nudge rather than a daily buzz people learn to swipe away.
  if exists (select 1 from public.entries where day = local_now::date) then
    return;
  end if;

  perform net.http_post(
    url := fn_url,
    body := jsonb_build_object(
      'reminder', jsonb_build_object('day', to_char(local_now::date, 'YYYY-MM-DD'))
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-khata-hook', hook_secret
    ),
    timeout_milliseconds := 5000
  );
exception
  -- Same reasoning as notify_push: a missed reminder is a nuisance, a failing
  -- scheduled job is noise in the logs forever. Degrade to silence.
  when others then
    return;
end;
$$;

revoke execute on function public.notify_reminder() from public;
revoke execute on function public.notify_reminder() from anon, authenticated;

-- Hourly at :30 — the function picks its hour. Re-scheduling the same job
-- name replaces it, so re-running this migration is safe.
select cron.schedule('khata-daily-reminder', '30 * * * *', 'select public.notify_reminder()');
