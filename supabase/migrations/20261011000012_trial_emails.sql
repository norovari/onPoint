-- 1. The launch offer (20% off the first 3 months) now stays open for the whole
--    3-day trial plus 2 days after it, instead of 24 hours from sign-up.
-- 2. Two emails to the owner: the day before the trial ends, and once it has
--    ended. The daily job (/api/cron/billing) sends them; these functions pick
--    who is due, with their own numbers, and record that each email went out.

do $$
declare f text; src text;
begin
  foreach f in array array['public.business_plan(uuid)', 'private.quote(uuid, subscription_plan)'] loop
    src := pg_get_functiondef(f::regprocedure);
    if position('interval ''24 hours''' in src) = 0 then
      raise exception 'Expected the 24-hour launch window in %', f;
    end if;
    execute replace(src, 'interval ''24 hours''', 'interval ''5 days''');
  end loop;
end $$;

alter table public.subscriptions add column if not exists trial_ending_emailed_at timestamptz;
alter table public.subscriptions add column if not exists trial_ended_emailed_at timestamptz;

-- Shops due a trial email now, with what OnPoint caught during the trial.
-- kind 'ending': trial ends within the next 30 hours. kind 'ended': ended in the last 3 days.
create or replace function public.billing_trial_emails_due()
returns table (
  business_id uuid, kind text, business_name text, reference text, email text,
  trial_end timestamptz, discount_until timestamptz,
  shifts_closed int, alerts int, missing_value numeric, cash_short numeric
)
language sql stable security definer set search_path = ''
as $$
  with due as (
    select s.business_id, s.reference, s.current_period_end,
      case
        when s.current_period_end > now() and s.current_period_end <= now() + interval '30 hours'
             and s.trial_ending_emailed_at is null then 'ending'
        when s.current_period_end <= now() and s.current_period_end > now() - interval '3 days'
             and s.trial_ended_emailed_at is null then 'ended'
      end as kind,
      coalesce(s.billing_email,
        (select u.email from public.memberships m join auth.users u on u.id = m.user_id
          where m.business_id = s.business_id and m.role = 'owner' and m.active order by m.created_at limit 1)) as email
    from public.subscriptions s
    where s.status = 'trialing'
  )
  select d.business_id, d.kind, b.name, d.reference, d.email, d.current_period_end,
    b.created_at + interval '5 days',
    (select count(*)::int from public.shifts sh where sh.business_id = d.business_id and sh.status not in ('opening', 'active')),
    (select count(*)::int from public.exceptions e where e.business_id = d.business_id and e.stage = 'closing'
       and e.status <> 'superseded' and e.exception_type <> 'low_stock'),
    coalesce((select sum(-e.difference * pp.unit_price) from public.exceptions e
       join public.product_prices pp on pp.product_id = e.product_id and pp.valid_to is null
      where e.business_id = d.business_id and e.exception_type = 'stock_variance' and e.stage = 'closing'
        and e.status <> 'superseded' and e.difference < 0), 0),
    coalesce((select sum(-e.difference) from public.exceptions e
      where e.business_id = d.business_id and e.exception_type = 'cash_variance' and e.stage = 'closing'
        and e.status <> 'superseded' and e.difference < 0), 0)
  from due d join public.businesses b on b.id = d.business_id
  where d.kind is not null and d.email is not null
$$;

create or replace function public.billing_mark_trial_email(p_business uuid, p_kind text)
returns void
language sql security definer set search_path = ''
as $$
  update public.subscriptions set
    trial_ending_emailed_at = case when p_kind = 'ending' then now() else trial_ending_emailed_at end,
    trial_ended_emailed_at  = case when p_kind = 'ended'  then now() else trial_ended_emailed_at end
  where business_id = p_business
$$;

-- Server only (the daily job uses the service key)
revoke execute on function public.billing_trial_emails_due() from public, anon, authenticated;
revoke execute on function public.billing_mark_trial_email(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_trial_emails_due() to service_role;
grant execute on function public.billing_mark_trial_email(uuid, text) to service_role;
