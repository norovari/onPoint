-- New list prices (rand per month): Starter R99, Business R499, Multi-site R999.
-- Keep in step with lib/plans.ts.
create or replace function private.plan_price(p_plan subscription_plan)
returns numeric language sql immutable as $$
  select case p_plan when 'starter' then 99 when 'business' then 499 when 'multi_site' then 999 else 0 end::numeric
$$;
