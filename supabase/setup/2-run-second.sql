-- OnPoint database setup, PART 2 of 2. Run this after PART 1 has finished successfully.

-- ===== 20261011000006_v1.sql =====
-- OnPoint v1 — plans and billing, platform admin, specials, alerts, till totals.

-- ===========================================================================
-- 1. Platform admin (the OnPoint owner). Access is granted to a confirmed
--    sign-in whose email is on this list. No password is stored here.
-- ===========================================================================
create table platform_admin_emails (email text primary key check (email = lower(email)));
alter table platform_admin_emails enable row level security; -- no policies: never readable from the app
insert into platform_admin_emails (email) values ('nyorovai@gmail.com');

create or replace function private.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select true from auth.users u
    join public.platform_admin_emails a on a.email = lower(u.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null
  ), false)
$$;
grant execute on function private.is_platform_admin() to authenticated;

create or replace function public.am_platform_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select private.is_platform_admin() $$;
revoke execute on function public.am_platform_admin() from public, anon;
grant execute on function public.am_platform_admin() to authenticated;

-- ===========================================================================
-- 2. Products: low-stock warning level. Shifts: till report and card machine.
-- ===========================================================================
alter table products add column low_stock_level numeric(14,3) check (low_stock_level is null or low_stock_level >= 0);
alter table shifts add column card_machine_total numeric(14,2) check (card_machine_total is null or card_machine_total >= 0);
alter table shifts add column till_cash_total numeric(14,2) check (till_cash_total is null or till_cash_total >= 0);
alter table shifts add column till_card_total numeric(14,2) check (till_card_total is null or till_card_total >= 0);

-- ===========================================================================
-- 3. Specials ("2 for R200" deals) and what went out with them
-- ===========================================================================
create table specials (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete restrict,
  name           text not null check (length(trim(name)) > 0),
  code           text,  -- code used for the deal in the till export
  deal_price     numeric(14,2) not null check (deal_price >= 0),
  items_per_deal int not null check (items_per_deal between 1 and 50),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (business_id, code)
);
create index on specials (business_id);

create table special_products (
  special_id uuid not null references specials(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  primary key (special_id, product_id)
);

-- Deals rung up by hand (when the till export has no deal reference)
create table special_sales (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  shift_id    uuid not null references shifts(id) on delete restrict,
  special_id  uuid not null references specials(id) on delete restrict,
  deals       int not null check (deals > 0),
  created_by  uuid not null references profiles(id),
  created_at  timestamptz not null default now()
);
create index on special_sales (shift_id);

alter table pos_sales_lines add column special_id uuid references specials(id);
alter table pos_sales_lines add column deal_ref text;
alter table pos_imports drop constraint if exists pos_imports_source_check;

alter table specials enable row level security;
alter table special_products enable row level security;
alter table special_sales enable row level security;

create policy specials_select on specials for select to authenticated using (private.is_member(business_id));
create policy specials_write on specials for all to authenticated
  using (private.is_owner(business_id)) with check (private.is_owner(business_id));
create policy special_products_select on special_products for select to authenticated
  using (exists (select 1 from specials s where s.id = special_id and private.is_member(s.business_id)));
create policy special_products_write on special_products for all to authenticated
  using (exists (select 1 from specials s where s.id = special_id and private.is_owner(s.business_id)))
  with check (exists (select 1 from specials s join products p on p.id = product_id
                      where s.id = special_id and p.business_id = s.business_id and private.is_owner(s.business_id)));
create policy special_sales_select on special_sales for select to authenticated using (private.can_access_shift(shift_id));

create trigger special_sales_append_only before update or delete on special_sales
  for each row execute function private.forbid_change();
create trigger special_sales_audit after insert on special_sales
  for each row execute function private.audit_row();
create trigger specials_audit after insert or update or delete on specials
  for each row execute function private.audit_row();

-- ===========================================================================
-- 4. Plans, subscriptions, invoices
-- ===========================================================================
alter table subscriptions alter column plan set default 'free';
alter table subscriptions add column discount_pct int not null default 0 check (discount_pct between 0 and 100);
alter table subscriptions add column discount_cycles_remaining int not null default 0 check (discount_cycles_remaining >= 0);
alter table subscriptions add column payment_method text check (payment_method in ('card', 'eft'));
alter table subscriptions add column paystack_authorization_code text;
alter table subscriptions add column paystack_customer_code text;
alter table subscriptions add column billing_email text;
alter table subscriptions add column past_due_since timestamptz;
alter table subscriptions add column last_charge_attempt_at timestamptz;

create sequence invoice_number_seq start 1001;
create table invoices (
  id           uuid primary key default gen_random_uuid(),
  number       bigint not null unique default nextval('invoice_number_seq'),
  business_id  uuid not null references businesses(id) on delete restrict,
  plan         subscription_plan not null,
  method       text not null check (method in ('card', 'eft')),
  reference    text not null unique check (reference ~ '^[A-Za-z0-9.=-]{6,64}$'),
  list_amount  numeric(14,2) not null check (list_amount >= 0),
  discount_pct int not null default 0,
  amount       numeric(14,2) not null check (amount >= 0),
  status       text not null default 'pending' check (status in ('pending', 'paid', 'void', 'failed')),
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  paid_at      timestamptz,
  marked_paid_by uuid references profiles(id)
);
create index on invoices (business_id, created_at desc);
alter table invoices enable row level security;
create policy invoices_select on invoices for select to authenticated using (private.is_owner(business_id));

-- List prices in rand per month. Change here (and in lib/plans.ts) to reprice.
create or replace function private.plan_price(p_plan subscription_plan)
returns numeric language sql immutable as $$
  select case p_plan when 'starter' then 299 when 'business' then 699 when 'multi_site' then 1499 else 0 end::numeric
$$;

-- The plan a business can actually use right now.
create or replace function private.effective_plan(p_business uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select case
      when s.status in ('active', 'trialing') and (s.current_period_end is null or s.current_period_end > now()) then s.plan::text
      when s.status = 'past_due' and s.past_due_since > now() - interval '7 days' then s.plan::text
      else 'free' end
    from public.subscriptions s where s.business_id = p_business
  ), 'free')
$$;

create or replace function public.business_plan(p_business uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_sub public.subscriptions%rowtype; v_biz public.businesses%rowtype; v_paid boolean;
begin
  if not private.is_member(p_business) then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;
  select * into v_sub from public.subscriptions where business_id = p_business;
  select * into v_biz from public.businesses where id = p_business;
  select exists (select 1 from public.invoices where business_id = p_business and status = 'paid') into v_paid;
  return jsonb_build_object(
    'plan', private.effective_plan(p_business),
    'subscribed_plan', v_sub.plan,
    'status', v_sub.status,
    'current_period_end', v_sub.current_period_end,
    'payment_method', v_sub.payment_method,
    'discount_cycles_remaining', v_sub.discount_cycles_remaining,
    'discount_pct', v_sub.discount_pct,
    'launch_discount_until', case when not v_paid then v_biz.created_at + interval '24 hours' end,
    'launch_discount_open', (not v_paid and now() < v_biz.created_at + interval '24 hours'),
    'history_days', private.history_days(p_business)
  );
end $$;

create or replace function private.history_days(p_business uuid)
returns int language sql stable security definer set search_path = ''
as $$ select case private.effective_plan(p_business) when 'free' then 7 when 'starter' then 90 else null end $$;

-- Free plan: up to 15 active products. More than one location: Multi-site plan.
create or replace function private.enforce_product_limit()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.active and private.effective_plan(new.business_id) = 'free'
     and (select count(*) from public.products p where p.business_id = new.business_id and p.active and p.id <> new.id) >= 15 then
    raise exception 'The free plan includes up to 15 products. Upgrade to add more.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger products_plan_limit before insert or update of active on products
  for each row execute function private.enforce_product_limit();

create or replace function private.enforce_location_limit()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if private.effective_plan(new.business_id) <> 'multi_site'
     and exists (select 1 from public.locations l where l.business_id = new.business_id and l.active) then
    raise exception 'More than one shop needs the Multi-site plan.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger locations_plan_limit before insert on locations
  for each row execute function private.enforce_location_limit();

-- History limit: approved shifts older than the plan allows are hidden.
create or replace function private.can_access_shift(p_shift uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.shifts s
    where s.id = p_shift
      and private.can_access_location(s.business_id, s.location_id)
      and (s.status <> 'approved' or private.history_days(s.business_id) is null
           or s.opened_at > now() - make_interval(days => private.history_days(s.business_id)))
  )
$$;

drop policy shifts_select on shifts;
create policy shifts_select on shifts for select to authenticated
  using (private.can_access_shift(id));

-- New businesses get the Business plan free for 3 days, then drop to Free.
create or replace function public.create_business(p_name text, p_location_name text default 'Main store', p_standard_float numeric default 500)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_biz uuid; v_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Enter your business name' using errcode = '22023';
  end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;
  select email into v_email from auth.users where id = auth.uid();

  insert into public.businesses (name) values (trim(p_name)) returning id into v_biz;
  insert into public.locations (business_id, name, standard_float)
    values (v_biz, coalesce(nullif(trim(p_location_name), ''), 'Main store'), greatest(coalesce(p_standard_float, 0), 0));
  insert into public.memberships (business_id, user_id, role) values (v_biz, auth.uid(), 'owner');
  insert into public.subscriptions (business_id, plan, status, current_period_end, billing_email)
    values (v_biz, 'business', 'trialing', now() + interval '3 days', v_email);
  return v_biz;
end $$;
revoke execute on function public.create_business(text, text, numeric) from public, anon;
grant execute on function public.create_business(text, text, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- Billing: quote, create invoice (owner), record payment (server only)
-- Launch offer: subscribe within 24 hours of creating the business and the
-- first 3 monthly payments are 20% off.
-- ---------------------------------------------------------------------------
create or replace function private.quote(p_business uuid, p_plan subscription_plan)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_list numeric := private.plan_price(p_plan); v_pct int := 0; v_sub public.subscriptions%rowtype; v_biz public.businesses%rowtype;
begin
  select * into v_sub from public.subscriptions where business_id = p_business;
  select * into v_biz from public.businesses where id = p_business;
  if not exists (select 1 from public.invoices where business_id = p_business and status = 'paid') then
    if now() < v_biz.created_at + interval '24 hours' then v_pct := 20; end if;
  elsif v_sub.discount_cycles_remaining > 0 then
    v_pct := v_sub.discount_pct;
  end if;
  return jsonb_build_object('plan', p_plan, 'list_amount', v_list, 'discount_pct', v_pct,
                            'amount', round(v_list * (100 - v_pct) / 100, 2));
end $$;

create or replace function public.billing_quote(p_business uuid, p_plan subscription_plan)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_owner(p_business) then raise exception 'Only the owner can manage the subscription' using errcode = '42501'; end if;
  if p_plan = 'free' then raise exception 'Choose a paid plan' using errcode = '22023'; end if;
  return private.quote(p_business, p_plan);
end $$;

create or replace function public.billing_create_invoice(p_business uuid, p_plan subscription_plan, p_method text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_q jsonb; v_ref text; v_inv public.invoices%rowtype;
begin
  if not private.is_owner(p_business) then raise exception 'Only the owner can manage the subscription' using errcode = '42501'; end if;
  if p_plan = 'free' then raise exception 'Choose a paid plan' using errcode = '22023'; end if;
  if p_method not in ('card', 'eft') then raise exception 'Choose card or EFT' using errcode = '22023'; end if;
  -- One open EFT invoice at a time; earlier unpaid ones are voided
  update public.invoices set status = 'void' where business_id = p_business and status = 'pending';
  v_q := private.quote(p_business, p_plan);
  v_ref := 'OP' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.invoices (business_id, plan, method, reference, list_amount, discount_pct, amount, created_by)
  values (p_business, p_plan, p_method, v_ref, (v_q->>'list_amount')::numeric, (v_q->>'discount_pct')::int,
          (v_q->>'amount')::numeric, auth.uid())
  returning * into v_inv;
  return to_jsonb(v_inv);
end $$;

-- Applies a confirmed payment to an invoice and extends the subscription by a month.
create or replace function private.apply_payment(p_invoice uuid, p_authorization text, p_customer text, p_email text, p_marked_by uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_inv public.invoices%rowtype; v_sub public.subscriptions%rowtype; v_first boolean; v_start timestamptz;
begin
  select * into v_inv from public.invoices where id = p_invoice for update;
  if not found then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
  if v_inv.status = 'paid' then return jsonb_build_object('already_paid', true, 'invoice', v_inv.number); end if;
  if v_inv.status = 'void' then raise exception 'That invoice was cancelled' using errcode = 'P0001'; end if;

  select not exists (select 1 from public.invoices where business_id = v_inv.business_id and status = 'paid') into v_first;
  select * into v_sub from public.subscriptions where business_id = v_inv.business_id for update;

  update public.invoices set status = 'paid', paid_at = now(), marked_paid_by = p_marked_by where id = p_invoice;

  -- A paid month starts after any remaining trial, or now
  v_start := case when v_sub.status = 'trialing' then greatest(now(), coalesce(v_sub.current_period_end, now()))
                  when v_sub.status = 'active' and v_sub.current_period_end > now() then v_sub.current_period_end
                  else now() end;

  update public.subscriptions set
    plan = v_inv.plan,
    status = 'active',
    current_period_end = v_start + interval '1 month',
    payment_method = v_inv.method,
    paystack_authorization_code = coalesce(p_authorization, case when v_inv.method = 'card' then paystack_authorization_code end),
    paystack_customer_code = coalesce(p_customer, paystack_customer_code),
    billing_email = coalesce(p_email, billing_email),
    discount_pct = case when v_first and v_inv.discount_pct > 0 then v_inv.discount_pct else discount_pct end,
    discount_cycles_remaining = case
      when v_first and v_inv.discount_pct > 0 then 2           -- this payment is the 1st of 3 discounted months
      when v_inv.discount_pct > 0 then greatest(discount_cycles_remaining - 1, 0)
      else discount_cycles_remaining end,
    past_due_since = null,
    updated_at = now()
  where business_id = v_inv.business_id;

  return jsonb_build_object('already_paid', false, 'invoice', v_inv.number, 'business_id', v_inv.business_id);
end $$;

-- Called only by the server (Paystack callback/webhook) with the service role key.
create or replace function public.billing_record_card_payment(p_reference text, p_amount_cents bigint, p_currency text,
  p_authorization text, p_reusable boolean, p_customer text, p_email text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_inv public.invoices%rowtype;
begin
  select * into v_inv from public.invoices where reference = p_reference;
  if not found then raise exception 'Unknown payment reference' using errcode = 'P0002'; end if;
  if upper(p_currency) <> 'ZAR' or p_amount_cents <> round(v_inv.amount * 100) then
    raise exception 'Payment amount does not match the invoice' using errcode = 'P0001';
  end if;
  return private.apply_payment(v_inv.id, case when p_reusable then p_authorization end, p_customer, p_email, null);
end $$;

-- Monthly card renewals due now (server only)
create or replace function public.billing_due_renewals()
returns table (business_id uuid, plan subscription_plan, email text, authorization_code text, amount numeric, discount_pct int)
language sql stable security definer set search_path = ''
as $$
  select s.business_id, s.plan, s.billing_email, s.paystack_authorization_code,
         (private.quote(s.business_id, s.plan)->>'amount')::numeric,
         (private.quote(s.business_id, s.plan)->>'discount_pct')::int
  from public.subscriptions s
  where s.payment_method = 'card' and s.paystack_authorization_code is not null
    and s.status in ('active', 'past_due') and s.plan <> 'free'
    and s.current_period_end <= now()
    and (s.last_charge_attempt_at is null or s.last_charge_attempt_at < now() - interval '20 hours')
    and (s.past_due_since is null or s.past_due_since > now() - interval '7 days')
$$;

create or replace function public.billing_start_renewal(p_business uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_sub public.subscriptions%rowtype; v_q jsonb; v_inv public.invoices%rowtype;
begin
  select * into v_sub from public.subscriptions where business_id = p_business for update;
  update public.subscriptions set last_charge_attempt_at = now() where business_id = p_business;
  v_q := private.quote(p_business, v_sub.plan);
  insert into public.invoices (business_id, plan, method, reference, list_amount, discount_pct, amount)
  values (p_business, v_sub.plan, 'card', 'OPR' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
          (v_q->>'list_amount')::numeric, (v_q->>'discount_pct')::int, (v_q->>'amount')::numeric)
  returning * into v_inv;
  return to_jsonb(v_inv);
end $$;

create or replace function public.billing_renewal_failed(p_reference text)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_inv public.invoices%rowtype;
begin
  select * into v_inv from public.invoices where reference = p_reference;
  if not found then return; end if;
  update public.invoices set status = 'failed' where id = v_inv.id and status = 'pending';
  update public.subscriptions set status = 'past_due', past_due_since = coalesce(past_due_since, now()), updated_at = now()
   where business_id = v_inv.business_id;
end $$;

-- Lock billing functions to the server's service role
do $$
declare f text;
begin
  foreach f in array array[
    'public.billing_record_card_payment(text, bigint, text, text, boolean, text, text)',
    'public.billing_due_renewals()',
    'public.billing_start_renewal(uuid)',
    'public.billing_renewal_failed(text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end $$;
revoke execute on function public.billing_quote(uuid, subscription_plan) from public, anon;
revoke execute on function public.billing_create_invoice(uuid, subscription_plan, text) from public, anon;
revoke execute on function public.business_plan(uuid) from public, anon;
grant execute on function public.billing_quote(uuid, subscription_plan) to authenticated;
grant execute on function public.billing_create_invoice(uuid, subscription_plan, text) to authenticated;
grant execute on function public.business_plan(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Platform admin: account-level view only. No stock, sales or cash figures.
-- ---------------------------------------------------------------------------
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Not found' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.created_at desc)
    from (
      select b.id, b.name, b.created_at, b.status as business_status,
        (select u.email from public.memberships m join auth.users u on u.id = m.user_id
          where m.business_id = b.id and m.role = 'owner' order by m.created_at limit 1) as owner_email,
        s.plan, s.status, s.current_period_end, s.payment_method, s.discount_cycles_remaining,
        private.effective_plan(b.id) as effective_plan,
        private.plan_price(s.plan) as list_price,
        (select count(*) from public.memberships m where m.business_id = b.id and m.active) as team,
        (select count(*) from public.locations l where l.business_id = b.id and l.active) as locations,
        (select count(*) from public.products p where p.business_id = b.id and p.active) as products,
        (select count(*) from public.shifts sh where sh.business_id = b.id and sh.closing_submitted_at > now() - interval '30 days') as shifts_30d,
        (select max(sh.closing_submitted_at) from public.shifts sh where sh.business_id = b.id) as last_shift_at,
        (select count(*) from public.exceptions e where e.business_id = b.id and e.status in ('open', 'explained')) as open_alerts,
        (select count(*) from public.invoices i where i.business_id = b.id and i.status = 'pending') as pending_invoices,
        (select coalesce(sum(i.amount), 0) from public.invoices i where i.business_id = b.id and i.status = 'paid') as total_paid
      from public.businesses b
      left join public.subscriptions s on s.business_id = b.id
    ) x
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_invoices(p_status text default 'pending')
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Not found' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'business', b.name, 'plan', i.plan, 'method', i.method,
      'reference', i.reference, 'amount', i.amount, 'discount_pct', i.discount_pct, 'status', i.status,
      'created_at', i.created_at, 'paid_at', i.paid_at) order by i.created_at desc)
    from public.invoices i join public.businesses b on b.id = i.business_id
    where p_status = 'all' or i.status = p_status
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_mark_invoice_paid(p_invoice uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Not found' using errcode = 'P0002'; end if;
  return private.apply_payment(p_invoice, null, null, null, auth.uid());
end $$;

create or replace function public.admin_set_subscription(p_business uuid, p_plan subscription_plan, p_status subscription_state, p_period_end timestamptz)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Not found' using errcode = 'P0002'; end if;
  update public.subscriptions set plan = p_plan, status = p_status, current_period_end = p_period_end,
    past_due_since = case when p_status = 'past_due' then coalesce(past_due_since, now()) end, updated_at = now()
  where business_id = p_business;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.admin_overview()', 'public.admin_invoices(text)', 'public.admin_mark_invoice_paid(uuid)',
                           'public.admin_set_subscription(uuid, subscription_plan, subscription_state, timestamptz)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ===========================================================================
-- 5. Till report figures, card machine, hand-recorded specials
-- ===========================================================================
create or replace function public.record_till_totals(p_shift uuid, p_cash numeric, p_card numeric)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found or not private.can_access_shift(p_shift) then raise exception 'Shift not found' using errcode = 'P0002'; end if;
  if not private.is_manager(v_shift.business_id) then raise exception 'Only managers and owners can enter till totals' using errcode = '42501'; end if;
  if v_shift.status not in ('active', 'correction_requested') then raise exception 'The shift is not open' using errcode = 'P0001'; end if;
  if p_cash < 0 or p_card < 0 then raise exception 'Totals cannot be negative' using errcode = '22023'; end if;
  perform private.begin_workflow();
  update public.shifts set till_cash_total = round(p_cash, 2), till_card_total = round(p_card, 2) where id = p_shift;
  perform private.end_workflow();
end $$;

-- p_mix: [{"product_id": "...", "qty": 3}, ...] — what went out with these deals
create or replace function public.record_special_sale(p_shift uuid, p_special uuid, p_deals int, p_mix jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype; v_sp public.specials%rowtype; v_import uuid; v_units numeric; v_taken numeric; r jsonb; i int := 0;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found or not private.can_access_shift(p_shift) then raise exception 'Shift not found' using errcode = 'P0002'; end if;
  if v_shift.status not in ('active', 'correction_requested') then raise exception 'The shift is not open' using errcode = 'P0001'; end if;
  select * into v_sp from public.specials where id = p_special and business_id = v_shift.business_id;
  if not found then raise exception 'Special not found' using errcode = 'P0002'; end if;
  if p_deals is null or p_deals < 1 then raise exception 'Enter how many deals were sold' using errcode = '22023'; end if;
  if jsonb_typeof(p_mix) <> 'array' or jsonb_array_length(p_mix) = 0 then raise exception 'Choose what went out with the deals' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_mix) m
             where (m->>'qty')::numeric <= 0
                or not exists (select 1 from public.products p where p.id = (m->>'product_id')::uuid and p.business_id = v_shift.business_id)) then
    raise exception 'Each item needs a product and a quantity above zero' using errcode = '22023';
  end if;

  select sum((m->>'qty')::numeric) into v_units from jsonb_array_elements(p_mix) m;
  v_taken := p_deals * v_sp.deal_price;

  insert into public.special_sales (business_id, shift_id, special_id, deals, created_by)
  values (v_shift.business_id, p_shift, p_special, p_deals, auth.uid());

  insert into public.pos_imports (business_id, location_id, shift_id, source, file_name, file_sha256, row_count, pos_total_sales, imported_by)
  values (v_shift.business_id, v_shift.location_id, p_shift, 'manual-special', v_sp.name,
          encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), jsonb_array_length(p_mix), v_taken, auth.uid())
  returning id into v_import;

  -- The money is shared across the items in proportion to quantity
  for r in select * from jsonb_array_elements(p_mix) loop
    i := i + 1;
    insert into public.pos_sales_lines (business_id, import_id, shift_id, external_ref, transaction_at, product_id, pos_code,
      quantity, gross_amount, discount_amount, tax_amount, payment_method, special_id)
    select v_shift.business_id, v_import, p_shift, 'special-' || v_import || '-' || i, now(), p.id, coalesce(p.pos_code, p.sku),
      (r->>'qty')::numeric, round(v_taken * (r->>'qty')::numeric / v_units, 2), 0, 0, 'other', p_special
    from public.products p where p.id = (r->>'product_id')::uuid;
  end loop;
  return jsonb_build_object('deals', p_deals, 'items', v_units, 'taken', v_taken);
end $$;

revoke execute on function public.record_till_totals(uuid, numeric, numeric) from public, anon;
revoke execute on function public.record_special_sale(uuid, uuid, int, jsonb) from public, anon;
grant execute on function public.record_till_totals(uuid, numeric, numeric) to authenticated;
grant execute on function public.record_special_sale(uuid, uuid, int, jsonb) to authenticated;

-- Email addresses to alert when a shift doesn't tally (owners and managers)
create or replace function public.shift_alert_recipients(p_shift uuid)
returns table (email text, full_name text)
language sql stable security definer set search_path = ''
as $$
  select u.email, p.full_name
  from public.shifts s
  join public.memberships m on m.business_id = s.business_id and m.active and m.role in ('owner', 'manager')
  join auth.users u on u.id = m.user_id
  join public.profiles p on p.id = m.user_id
  where s.id = p_shift and private.can_access_shift(p_shift) and u.email is not null
$$;
revoke execute on function public.shift_alert_recipients(uuid) from public, anon;
grant execute on function public.shift_alert_recipients(uuid) to authenticated;

-- ===== 20261011000007_reconciliation_v1.sql =====
-- OnPoint v1 — reconciliation with specials, minus and low-stock alerts,
-- till report totals and the card machine total. Replaces the earlier versions.

create or replace function public.shift_reconciliation(p_shift uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_shift   public.shifts%rowtype;
  v_biz     public.businesses%rowtype;
  v_stock   jsonb;
  v_sales   jsonb;
  v_cash    jsonb;
  v_settle  jsonb;
  v_money   boolean;
  v_specials jsonb;
  v_made    jsonb;
  v_usual   jsonb;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found or not private.can_access_shift(p_shift) then
    raise exception 'Shift not found' using errcode = 'P0002';
  end if;
  select * into v_biz from public.businesses where id = v_shift.business_id;
  v_money := private.can_see_shift_money(p_shift);

  -- Stock ------------------------------------------------------------------
  with latest_counts as (
    select distinct on (product_id, count_type) product_id, count_type, quantity
    from public.stock_counts
    where shift_id = p_shift
    order by product_id, count_type, version desc
  ),
  mv as (
    select product_id,
      sum(quantity) filter (where movement_type = 'RECEIPT')      as receipts,
      sum(quantity) filter (where movement_type = 'TRANSFER_IN')  as transfers_in,
      sum(quantity) filter (where movement_type = 'TRANSFER_OUT') as transfers_out,
      sum(quantity) filter (where movement_type = 'WASTAGE')      as wastage,
      sum(quantity) filter (where movement_type = 'DAMAGE')       as damage,
      sum(quantity) filter (where movement_type = 'INTERNAL_USE') as internal_use,
      sum(quantity) filter (where movement_type = 'ADJUSTMENT')   as adjustments,
      count(*) filter (where requires_approval and approved_by is null) as unapproved
    from public.stock_movements
    where shift_id = p_shift
    group by product_id
  ),
  sold as (
    select product_id, sum(quantity) as net_sold,
      coalesce(sum(quantity) filter (where special_id is not null), 0) as special_sold
    from public.pos_sales_lines
    where shift_id = p_shift and not is_void and product_id is not null
    group by product_id
  ),
  prod_rows as (
    select
      p.id, p.sku, p.name, p.tracking_mode, p.base_unit, p.low_stock_level,
      coalesce(sold.special_sold, 0) as special_sold,
      oc.quantity as opening,
      cc.quantity as counted_closing,
      coalesce(mv.receipts, 0) as receipts,
      coalesce(mv.transfers_in, 0) as transfers_in,
      coalesce(mv.transfers_out, 0) as transfers_out,
      coalesce(mv.wastage, 0) as wastage,
      coalesce(mv.damage, 0) as damage,
      coalesce(mv.internal_use, 0) as internal_use,
      coalesce(mv.adjustments, 0) as adjustments,
      coalesce(mv.unapproved, 0) as unapproved,
      coalesce(sold.net_sold, 0) as net_sold
    from public.products p
    left join latest_counts oc on oc.product_id = p.id and oc.count_type = 'opening'
    left join latest_counts cc on cc.product_id = p.id and cc.count_type = 'closing'
    left join mv on mv.product_id = p.id
    left join sold on sold.product_id = p.id
    where p.business_id = v_shift.business_id
      and (p.active or oc.quantity is not null or cc.quantity is not null)
  ),
  calc as (
    select r.*,
      case when r.opening is null then null else
        r.opening + r.receipts + r.transfers_in + r.adjustments
        - r.net_sold - r.transfers_out - r.wastage - r.damage - r.internal_use
      end as expected_closing
    from prod_rows r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', c.id, 'sku', c.sku, 'name', c.name,
      'tracking_mode', c.tracking_mode, 'base_unit', c.base_unit,
      'opening', c.opening, 'receipts', c.receipts, 'transfers_in', c.transfers_in,
      'transfers_out', c.transfers_out, 'wastage', c.wastage, 'damage', c.damage,
      'internal_use', c.internal_use, 'adjustments', c.adjustments,
      'net_sold', c.net_sold, 'special_sold', c.special_sold, 'unapproved_movements', c.unapproved,
      'low_stock_level', c.low_stock_level,
      'went_into_minus', coalesce(c.expected_closing < 0, false),
      'low_next', coalesce(c.counted_closing <= c.low_stock_level, false),
      'expected_closing', c.expected_closing,
      'counted_closing', c.counted_closing,
      'variance', c.counted_closing - c.expected_closing,
      'status', case
        when c.opening is null or c.counted_closing is null then 'missing_evidence'
        when abs(c.counted_closing - c.expected_closing)
             <= abs(c.expected_closing) * v_biz.stock_tolerance_pct / 100 then 'matched'
        else 'variance' end
    ) order by c.sku), '[]'::jsonb)
  into v_stock
  from calc c;

  -- Staff without money access get stock only
  if not v_money then
    return jsonb_build_object('shift_id', p_shift, 'stock', v_stock, 'money_visible', false);
  end if;

  -- Sales value ------------------------------------------------------------
  select jsonb_build_object(
    'pos_gross',       coalesce(sum(l.gross_amount), 0),
    'pos_discounts',   coalesce(sum(l.discount_amount), 0),
    'pos_net',         coalesce(sum(l.gross_amount - l.discount_amount), 0),
    'pos_refunds',     coalesce(-sum(l.gross_amount) filter (where l.is_refund), 0),
    'calculated_at_list', coalesce(round(sum(l.quantity * private.price_at(l.product_id, l.transaction_at))
                                  filter (where l.product_id is not null), 2), 0),
    'unmapped_lines',  count(*) filter (where l.product_id is null),
    'unpriced_lines',  count(*) filter (where l.product_id is not null
                                        and private.price_at(l.product_id, l.transaction_at) is null),
    'import_count',    (select count(*) from public.pos_imports i where i.shift_id = p_shift and i.status = 'validated' and i.source <> 'manual-special')
  )
  into v_sales
  from public.pos_sales_lines l
  where l.shift_id = p_shift and not l.is_void;

  -- Compare list-price value with POS gross (both before discount, tax-inclusive),
  -- over mapped and priced lines only, so like is compared with like.
  v_sales := v_sales || jsonb_build_object(
    'pos_gross_mapped', (
      select coalesce(sum(l.gross_amount), 0) from public.pos_sales_lines l
      where l.shift_id = p_shift and not l.is_void and l.product_id is not null
        and private.price_at(l.product_id, l.transaction_at) is not null)
  );
  v_sales := v_sales || jsonb_build_object(
    'sales_value_variance', (v_sales ->> 'calculated_at_list')::numeric - (v_sales ->> 'pos_gross_mapped')::numeric
  );

  -- Cash -------------------------------------------------------------------
  with c as (
    select
      coalesce(sum(gross_amount - discount_amount) filter (where not is_refund), 0)  as cash_sales,
      coalesce(-sum(gross_amount - discount_amount) filter (where is_refund), 0)     as cash_refunds
    from public.pos_sales_lines
    where shift_id = p_shift and not is_void and payment_method = 'cash'
  ),
  e as (
    select
      coalesce(sum(amount) filter (where event_type = 'PAID_IN'), 0)  as paid_in,
      coalesce(sum(amount) filter (where event_type = 'PAID_OUT'), 0) as paid_out,
      coalesce(sum(amount) filter (where event_type = 'REMOVED'), 0)  as removed,
      coalesce(sum(amount) filter (where event_type = 'BANKED'), 0)   as banked
    from public.cash_events where shift_id = p_shift
  ),
  x as (
    select
      coalesce(v_shift.till_cash_total, c.cash_sales) as cash_sales,
      case when v_shift.till_cash_total is null then c.cash_refunds else 0 end as cash_refunds,
      e.*,
      coalesce(v_shift.opening_float, 0) + coalesce(v_shift.till_cash_total, c.cash_sales)
        - case when v_shift.till_cash_total is null then c.cash_refunds else 0 end
        + e.paid_in - e.paid_out - e.removed - e.banked as expected
    from c, e
  )
  select jsonb_build_object(
    'opening_float', coalesce(v_shift.opening_float, 0),
    'source', case when v_shift.till_cash_total is null then 'pos_lines' else 'till_report' end,
    'cash_sales', x.cash_sales, 'cash_refunds', x.cash_refunds,
    'paid_in', x.paid_in, 'paid_out', x.paid_out, 'removed', x.removed, 'banked', x.banked,
    'expected', x.expected,
    'counted', v_shift.counted_closing_cash,
    'variance', v_shift.counted_closing_cash - x.expected,
    'status', case
      when v_shift.counted_closing_cash is null then 'missing_evidence'
      when abs(v_shift.counted_closing_cash - x.expected) <= v_biz.cash_tolerance then 'matched'
      else 'variance' end
  )
  into v_cash
  from x;

  -- Card / EFT settlements ------------------------------------------------
  with pos0 as (
    select payment_method, sum(gross_amount - discount_amount) as pos_net
    from public.pos_sales_lines
    where shift_id = p_shift and not is_void and payment_method not in ('cash', 'other')
    group by payment_method
  ),
  pos as (
    select payment_method,
      case when payment_method = 'card' and v_shift.till_card_total is not null then v_shift.till_card_total else pos_net end as pos_net
    from pos0
    union all
    select 'card'::public.payment_method, v_shift.till_card_total
    where v_shift.till_card_total is not null and not exists (select 1 from pos0 where payment_method = 'card')
  ),
  st_rows as (
    select payment_method, gross_amount, refunds, fees, adjustments, net_amount, provider || ':' || provider_reference as ref
    from public.settlement_records where shift_id = p_shift
    union all
    select 'card'::public.payment_method, v_shift.card_machine_total, 0, 0, 0, v_shift.card_machine_total, 'Card machine end-of-day total'
    where v_shift.card_machine_total is not null
  ),
  st as (
    select payment_method,
      sum(gross_amount) as gross, sum(refunds) as refunds, sum(fees) as fees,
      sum(adjustments) as adjustments, sum(net_amount) as net,
      jsonb_agg(ref order by ref) as refs
    from st_rows
    group by payment_method
  ),
  m as (
    select coalesce(pos.payment_method, st.payment_method) as method,
      coalesce(pos.pos_net, 0) as pos_net, st.*
    from pos full join st on st.payment_method = pos.payment_method
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'method', m.method,
      'pos_expected', m.pos_net,
      'settled_gross', m.gross, 'refunds', m.refunds, 'fees', m.fees,
      'adjustments', m.adjustments, 'net', m.net,
      -- expected net = POS net - fees + adjustments; variance = actual net - expected net
      'expected_net', case when m.gross is null then null else m.pos_net - m.fees + m.adjustments end,
      'variance', case when m.gross is null then null else m.net - (m.pos_net - m.fees + m.adjustments) end,
      'references', coalesce(m.refs, '[]'::jsonb),
      'status', case
        when m.gross is null then 'pending'
        when m.net - (m.pos_net - m.fees + m.adjustments) = 0 then 'matched'
        else 'variance' end
    ) order by m.method), '[]'::jsonb)
  into v_settle
  from m;

  -- Specials ----------------------------------------------------------------
  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) into v_specials
  from (
    select jsonb_build_object(
      'special_id', sp.id, 'name', sp.name, 'deal_price', sp.deal_price, 'items_per_deal', sp.items_per_deal,
      'deals', a.deals, 'units', a.units, 'should_units', a.deals * sp.items_per_deal,
      'extra', a.units - a.deals * sp.items_per_deal,
      'taken', a.taken,
      'at_normal_price', round(least(a.units, a.deals * sp.items_per_deal) * a.avg_price, 2),
      'discount', round(least(a.units, a.deals * sp.items_per_deal) * a.avg_price, 2) - a.taken,
      'extra_value', round(greatest(a.units - a.deals * sp.items_per_deal, 0) * a.avg_price, 2),
      'normal_sold_same_items', a.normal_same,
      'mix', a.mix
    ) as x
    from public.specials sp
    cross join lateral (
      select
        coalesce((select count(distinct l.deal_ref) from public.pos_sales_lines l
                  where l.shift_id = p_shift and l.special_id = sp.id and not l.is_void and l.deal_ref is not null), 0)
          + coalesce((select sum(ss.deals) from public.special_sales ss where ss.shift_id = p_shift and ss.special_id = sp.id), 0) as deals,
        coalesce(sum(l.quantity), 0) as units,
        coalesce(sum(l.gross_amount - l.discount_amount), 0) as taken,
        case when coalesce(sum(l.quantity), 0) = 0 then 0
             else coalesce(sum(l.quantity * private.price_at(l.product_id, l.transaction_at)), 0) / sum(l.quantity) end as avg_price,
        coalesce((select sum(n.quantity) from public.pos_sales_lines n
                  where n.shift_id = p_shift and not n.is_void and n.special_id is null
                    and n.product_id in (select l2.product_id from public.pos_sales_lines l2
                                         where l2.shift_id = p_shift and l2.special_id = sp.id)), 0) as normal_same,
        coalesce((select jsonb_agg(jsonb_build_object('product_id', m.product_id, 'name', m.name, 'qty', m.qty) order by m.qty desc, m.name)
                  from (select l3.product_id, p3.name, sum(l3.quantity) as qty
                        from public.pos_sales_lines l3 join public.products p3 on p3.id = l3.product_id
                        where l3.shift_id = p_shift and l3.special_id = sp.id and not l3.is_void
                        group by l3.product_id, p3.name) m), '[]'::jsonb) as mix
      from public.pos_sales_lines l
      where l.shift_id = p_shift and l.special_id = sp.id and not l.is_void
    ) a
    where sp.business_id = v_shift.business_id and (a.units > 0 or a.deals > 0)
  ) s;

  -- What each product made --------------------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', p.id, 'name', p.name, 'base_unit', p.base_unit,
      'normal_qty', m.normal_qty, 'normal_amount', m.normal_amount,
      'special_qty', m.special_qty, 'special_amount', m.special_amount,
      'total_amount', m.normal_amount + m.special_amount
    ) order by m.normal_amount + m.special_amount desc, p.name), '[]'::jsonb)
  into v_made
  from public.products p
  join (
    select product_id,
      coalesce(sum(quantity) filter (where special_id is null), 0) as normal_qty,
      coalesce(sum(gross_amount - discount_amount) filter (where special_id is null), 0) as normal_amount,
      coalesce(sum(quantity) filter (where special_id is not null), 0) as special_qty,
      coalesce(sum(gross_amount - discount_amount) filter (where special_id is not null), 0) as special_amount
    from public.pos_sales_lines
    where shift_id = p_shift and not is_void and product_id is not null
    group by product_id
  ) m on m.product_id = p.id;

  -- A usual day: average takings of approved shifts here in the last 28 days without specials
  select jsonb_build_object('average', round(avg(q.t), 2), 'shifts', count(*)) into v_usual
  from (
    select sum(l.gross_amount - l.discount_amount) as t
    from public.shifts s2
    join public.pos_sales_lines l on l.shift_id = s2.id and not l.is_void
    where s2.location_id = v_shift.location_id and s2.status = 'approved' and s2.id <> p_shift
      and s2.opened_at > now() - interval '28 days'
      and not exists (select 1 from public.pos_sales_lines l2 where l2.shift_id = s2.id and l2.special_id is not null)
    group by s2.id
  ) q;

  return jsonb_build_object(
    'shift_id', p_shift,
    'money_visible', true,
    'specials', v_specials,
    'made', v_made,
    'usual_day', v_usual,
    'stock', v_stock,
    'sales', v_sales,
    'cash', v_cash,
    'settlements', v_settle
  );
end $$;

create or replace function public.import_pos_batch(
  p_shift uuid,
  p_file_name text,
  p_file_sha256 text,
  p_storage_path text,
  p_pos_total_sales numeric,
  p_pos_total_refunds numeric,
  p_lines jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift   public.shifts%rowtype;
  v_import  uuid;
  v_sales   numeric;
  v_refunds numeric;
  v_total   int;
  v_inserted int;
  v_unmapped int;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found or not private.can_access_shift(p_shift) then
    raise exception 'Shift not found' using errcode = 'P0002';
  end if;
  if not private.is_manager(v_shift.business_id) then
    raise exception 'Only managers and owners can import POS data' using errcode = '42501';
  end if;
  if v_shift.status not in ('active', 'correction_requested') then
    raise exception 'POS data can only be imported while the shift is active or being corrected' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.pos_imports where shift_id = p_shift and file_sha256 = p_file_sha256) then
    raise exception 'This exact file has already been imported for this shift' using errcode = '23505';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'The file contains no sales lines' using errcode = '22023';
  end if;

  -- The file's own totals must agree with its lines before anything is stored
  select
    coalesce(sum((l->>'gross_amount')::numeric - coalesce((l->>'discount_amount')::numeric, 0))
             filter (where not coalesce((l->>'is_void')::boolean, false) and not coalesce((l->>'is_refund')::boolean, false)), 0),
    coalesce(-sum((l->>'gross_amount')::numeric)
             filter (where not coalesce((l->>'is_void')::boolean, false) and coalesce((l->>'is_refund')::boolean, false)), 0),
    count(*)
  into v_sales, v_refunds, v_total
  from jsonb_array_elements(p_lines) l;

  if v_sales <> p_pos_total_sales or v_refunds <> p_pos_total_refunds then
    raise exception 'File totals do not match its lines (sales % vs %, refunds % vs %)',
      v_sales, p_pos_total_sales, v_refunds, p_pos_total_refunds using errcode = '22023';
  end if;

  insert into public.pos_imports (business_id, location_id, shift_id, file_name, file_sha256, storage_path,
                                  row_count, pos_total_sales, pos_total_refunds, imported_by)
  values (v_shift.business_id, v_shift.location_id, p_shift, p_file_name, p_file_sha256, p_storage_path,
          v_total, p_pos_total_sales, p_pos_total_refunds, auth.uid())
  returning id into v_import;

  with ins as (
    insert into public.pos_sales_lines (business_id, import_id, shift_id, external_ref, transaction_at,
      product_id, pos_code, quantity, gross_amount, discount_amount, tax_amount, payment_method, is_refund, is_void, special_id, deal_ref)
    select v_shift.business_id, v_import, p_shift,
      l->>'external_ref', (l->>'transaction_at')::timestamptz,
      p.id, l->>'pos_code', (l->>'quantity')::numeric, (l->>'gross_amount')::numeric,
      coalesce((l->>'discount_amount')::numeric, 0), coalesce((l->>'tax_amount')::numeric, 0),
      (l->>'payment_method')::public.payment_method,
      coalesce((l->>'is_refund')::boolean, false), coalesce((l->>'is_void')::boolean, false),
      sp.id, nullif(l->>'deal_ref', '')
    from jsonb_array_elements(p_lines) l
    -- Match the till's product code; products without a POS code match on SKU
    left join lateral (
      select p0.id from public.products p0
      where p0.business_id = v_shift.business_id
        and (p0.pos_code = l->>'pos_code' or (p0.pos_code is null and p0.sku = l->>'pos_code'))
      order by (p0.pos_code is not null) desc
      limit 1
    ) p on true
    left join public.specials sp on sp.business_id = v_shift.business_id and sp.code = nullif(l->>'special_code', '')
    on conflict (business_id, external_ref) do nothing
    returning product_id
  )
  select count(*), count(*) filter (where product_id is null) into v_inserted, v_unmapped from ins;

  return jsonb_build_object(
    'import_id', v_import,
    'lines_in_file', v_total,
    'inserted', v_inserted,
    'duplicates_skipped', v_total - v_inserted,
    'unmapped', v_unmapped
  );
end $$;

drop function public.submit_closing(uuid, numeric, jsonb, text);
create or replace function public.submit_closing(
  p_shift uuid,
  p_counted_cash numeric,
  p_checklist jsonb,
  p_notes text,
  p_card_machine_total numeric default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift   public.shifts%rowtype;
  v_missing int;
  v_recon   jsonb;
  v_version int;
  r         jsonb;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found or not private.can_access_shift(p_shift) then
    raise exception 'Shift not found' using errcode = 'P0002';
  end if;
  if v_shift.status not in ('active', 'correction_requested') then
    raise exception 'Shift cannot be submitted from status %', v_shift.status using errcode = 'P0001';
  end if;
  if p_card_machine_total is not null and p_card_machine_total < 0 then
    raise exception 'Card machine total must be zero or more' using errcode = '22023';
  end if;
  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'Counted cash must be zero or more' using errcode = '22023';
  end if;

  select count(*) into v_missing
  from public.products p
  where p.business_id = v_shift.business_id and p.active
    and not exists (select 1 from public.stock_counts c
                    where c.shift_id = p_shift and c.product_id = p.id and c.count_type = 'closing');
  if v_missing > 0 then
    raise exception '% product(s) still need a closing count', v_missing using errcode = 'P0001';
  end if;

  perform private.begin_workflow();

  -- A resubmission replaces the previous closing exceptions that are still open
  update public.exceptions
     set status = 'superseded', explanation = coalesce(explanation, 'Replaced by resubmitted close'),
         resolved_by = auth.uid(), resolved_at = now()
   where shift_id = p_shift and stage = 'closing' and status = 'open';

  update public.shifts
     set counted_closing_cash = round(p_counted_cash, 2),
         card_machine_total = round(p_card_machine_total, 2),
         closed_by = auth.uid(),
         closing_submitted_at = now(),
         status = 'closing_submitted'
   where id = p_shift;

  insert into public.handover_checklists (business_id, shift_id, submitted_by, checklist_data, notes)
  values (v_shift.business_id, p_shift, auth.uid(), coalesce(p_checklist, '{}'::jsonb), p_notes);

  -- Compute with full visibility (this function is the system, not the caller)
  v_recon := public.shift_reconciliation(p_shift);
  if not (v_recon ->> 'money_visible')::boolean then
    -- Staff submitting their own shift always have money visibility (they closed it),
    -- so this should not happen; guard anyway.
    raise exception 'Reconciliation unavailable' using errcode = 'P0001';
  end if;

  select coalesce(max(version), 0) + 1 into v_version from public.payment_reconciliations where shift_id = p_shift;

  -- Cash snapshot
  insert into public.payment_reconciliations (business_id, shift_id, payment_method, expected_amount,
         actual_amount, difference, status, calculation, version)
  values (v_shift.business_id, p_shift, 'cash',
          (v_recon #>> '{cash,expected}')::numeric,
          (v_recon #>> '{cash,counted}')::numeric,
          (v_recon #>> '{cash,variance}')::numeric,
          (v_recon #>> '{cash,status}')::public.recon_status,
          v_recon -> 'cash', v_version);

  if v_recon #>> '{cash,status}' = 'variance' then
    insert into public.exceptions (business_id, shift_id, exception_type, payment_method, expected, actual, difference, severity)
    values (v_shift.business_id, p_shift, 'cash_variance', 'cash',
            (v_recon #>> '{cash,expected}')::numeric, (v_recon #>> '{cash,counted}')::numeric,
            (v_recon #>> '{cash,variance}')::numeric, 'high');
  end if;

  -- Settlement snapshots
  for r in select * from jsonb_array_elements(v_recon -> 'settlements') loop
    insert into public.payment_reconciliations (business_id, shift_id, payment_method, expected_amount,
           actual_amount, difference, status, calculation, version)
    values (v_shift.business_id, p_shift, (r ->> 'method')::public.payment_method,
            coalesce((r ->> 'expected_net')::numeric, (r ->> 'pos_expected')::numeric),
            (r ->> 'net')::numeric, (r ->> 'variance')::numeric,
            (r ->> 'status')::public.recon_status, r, v_version);

    if r ->> 'status' = 'variance' then
      insert into public.exceptions (business_id, shift_id, exception_type, payment_method, expected, actual, difference, severity)
      values (v_shift.business_id, p_shift, 'settlement_variance', (r ->> 'method')::public.payment_method,
              (r ->> 'expected_net')::numeric, (r ->> 'net')::numeric, (r ->> 'variance')::numeric, 'review');
    end if;
  end loop;

  -- Stock exceptions
  insert into public.exceptions (business_id, shift_id, exception_type, product_id, expected, actual, difference, severity)
  select v_shift.business_id, p_shift,
         case when s ->> 'status' = 'variance' then 'stock_variance' else 'missing_evidence' end::public.exception_type,
         (s ->> 'product_id')::uuid,
         (s ->> 'expected_closing')::numeric, (s ->> 'counted_closing')::numeric, (s ->> 'variance')::numeric,
         'review'
  from jsonb_array_elements(v_recon -> 'stock') s
  where s ->> 'status' in ('variance', 'missing_evidence');

  -- Sales value and evidence gaps
  if (v_recon #>> '{sales,import_count}')::int = 0 then
    insert into public.exceptions (business_id, shift_id, exception_type, severity, explanation)
    values (v_shift.business_id, p_shift, 'missing_evidence', 'high', 'No POS export was imported for this shift');
  end if;
  if (v_recon #>> '{sales,unmapped_lines}')::int > 0 or (v_recon #>> '{sales,unpriced_lines}')::int > 0 then
    insert into public.exceptions (business_id, shift_id, exception_type, severity, explanation)
    values (v_shift.business_id, p_shift, 'missing_evidence', 'review',
            format('%s POS line(s) not mapped to a product, %s without a price',
                   v_recon #>> '{sales,unmapped_lines}', v_recon #>> '{sales,unpriced_lines}'));
  end if;
  if (v_recon #>> '{sales,sales_value_variance}')::numeric <> 0 then
    insert into public.exceptions (business_id, shift_id, exception_type, expected, actual, difference, severity)
    values (v_shift.business_id, p_shift, 'sales_value_variance',
            (v_recon #>> '{sales,calculated_at_list}')::numeric, (v_recon #>> '{sales,pos_gross_mapped}')::numeric,
            (v_recon #>> '{sales,sales_value_variance}')::numeric, 'info');
  end if;

  -- Went into minus: the till sold more than was in stock
  insert into public.exceptions (business_id, shift_id, exception_type, product_id, expected, actual, difference, severity, explanation)
  select v_shift.business_id, p_shift, 'went_into_minus', (s ->> 'product_id')::uuid,
         0, (s ->> 'expected_closing')::numeric, (s ->> 'expected_closing')::numeric, 'high',
         'More was sold than was in stock. A delivery may not have been logged.'
  from jsonb_array_elements(v_recon -> 'stock') s
  where (s ->> 'went_into_minus')::boolean;

  -- Specials that don't add up: deals × items per deal ≠ items that went out
  insert into public.exceptions (business_id, shift_id, exception_type, expected, actual, difference, severity, explanation)
  select v_shift.business_id, p_shift, 'special_mismatch',
         (x ->> 'should_units')::numeric, (x ->> 'units')::numeric, (x ->> 'extra')::numeric, 'high',
         format('%s: %s deals should be %s items, %s went out', x ->> 'name', x ->> 'deals', x ->> 'should_units', x ->> 'units')
  from jsonb_array_elements(v_recon -> 'specials') x
  where (x ->> 'extra')::numeric <> 0;

  -- Running low for the next shift
  insert into public.exceptions (business_id, shift_id, exception_type, product_id, expected, actual, difference, severity)
  select v_shift.business_id, p_shift, 'low_stock', (s ->> 'product_id')::uuid,
         (s ->> 'low_stock_level')::numeric, (s ->> 'counted_closing')::numeric, null, 'info'
  from jsonb_array_elements(v_recon -> 'stock') s
  where (s ->> 'low_next')::boolean;

  perform private.end_workflow();
  return v_recon;
end $$;

revoke execute on function public.submit_closing(uuid, numeric, jsonb, text, numeric) from public, anon;
grant execute on function public.submit_closing(uuid, numeric, jsonb, text, numeric) to authenticated;

select 'OnPoint database is ready' as result;


-- ===== 20261011000009_references.sql =====
-- Every subscription gets a permanent customer reference: NY0R0 + a number
-- (NY0R02192, NY0R02193, ...). Each card payment uses that reference plus a
-- payment number (NY0R02192-01, -02, ...) so Paystack sees a unique reference
-- per payment and every payment traces back to one customer.
-- Checkout is by card only (Paystack); there are no EFT invoices.

create sequence subscription_ref_seq start 2192;

create or replace function private.next_subscription_ref()
returns text language sql volatile security definer set search_path = ''
as $$ select 'NY0R0' || lpad(nextval('public.subscription_ref_seq')::text, 4, '0') $$;

alter table subscriptions add column reference text unique check (reference ~ '^NY0R0[0-9]{4,}$');
update subscriptions set reference = private.next_subscription_ref() where reference is null;
alter table subscriptions alter column reference set default private.next_subscription_ref();
alter table subscriptions alter column reference set not null;

-- References can't be changed once given
create or replace function private.protect_subscription_ref()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.reference is distinct from old.reference then
    raise exception 'A subscription reference never changes' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger subscriptions_protect_ref before update on subscriptions
  for each row execute function private.protect_subscription_ref();

-- Payments: link each to the customer reference and number them per customer
alter table invoices add column subscription_ref text references subscriptions(reference);
alter table invoices add column seq int;
update invoices i set subscription_ref = s.reference from subscriptions s where s.business_id = i.business_id;
create unique index invoices_subscription_seq on invoices (subscription_ref, seq) where seq is not null;

create or replace function private.next_payment(p_business uuid)
returns table (subscription_ref text, seq int, reference text)
language plpgsql volatile security definer set search_path = ''
as $$
declare v_ref text; v_seq int;
begin
  select s.reference into v_ref from public.subscriptions s where s.business_id = p_business for update;
  if v_ref is null then raise exception 'No subscription for this business' using errcode = 'P0002'; end if;
  select coalesce(max(i.seq), 0) + 1 into v_seq from public.invoices i where i.subscription_ref = v_ref;
  return query select v_ref, v_seq, v_ref || '-' || lpad(v_seq::text, 2, '0');
end $$;

create or replace function public.billing_create_invoice(p_business uuid, p_plan subscription_plan, p_method text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_q jsonb; v_n record; v_inv public.invoices%rowtype;
begin
  if not private.is_owner(p_business) then raise exception 'Only the owner can manage the subscription' using errcode = '42501'; end if;
  if p_plan = 'free' then raise exception 'Choose a paid plan' using errcode = '22023'; end if;
  if p_method <> 'card' then raise exception 'Pay by card' using errcode = '22023'; end if;
  -- Unfinished checkouts are cancelled when a new one starts
  update public.invoices set status = 'void' where business_id = p_business and status = 'pending';
  v_q := private.quote(p_business, p_plan);
  select * into v_n from private.next_payment(p_business);
  insert into public.invoices (business_id, plan, method, reference, subscription_ref, seq, list_amount, discount_pct, amount, created_by)
  values (p_business, p_plan, 'card', v_n.reference, v_n.subscription_ref, v_n.seq, (v_q->>'list_amount')::numeric,
          (v_q->>'discount_pct')::int, (v_q->>'amount')::numeric, auth.uid())
  returning * into v_inv;
  return to_jsonb(v_inv);
end $$;

create or replace function public.billing_start_renewal(p_business uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_sub public.subscriptions%rowtype; v_q jsonb; v_n record; v_inv public.invoices%rowtype;
begin
  select * into v_sub from public.subscriptions where business_id = p_business for update;
  update public.subscriptions set last_charge_attempt_at = now() where business_id = p_business;
  v_q := private.quote(p_business, v_sub.plan);
  select * into v_n from private.next_payment(p_business);
  insert into public.invoices (business_id, plan, method, reference, subscription_ref, seq, list_amount, discount_pct, amount)
  values (p_business, v_sub.plan, 'card', v_n.reference, v_n.subscription_ref, v_n.seq,
          (v_q->>'list_amount')::numeric, (v_q->>'discount_pct')::int, (v_q->>'amount')::numeric)
  returning * into v_inv;
  return to_jsonb(v_inv);
end $$;

-- Owners see their reference on the Plan page
create or replace function public.business_plan(p_business uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_sub public.subscriptions%rowtype; v_biz public.businesses%rowtype; v_paid boolean;
begin
  if not private.is_member(p_business) then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;
  select * into v_sub from public.subscriptions where business_id = p_business;
  select * into v_biz from public.businesses where id = p_business;
  select exists (select 1 from public.invoices where business_id = p_business and status = 'paid') into v_paid;
  return jsonb_build_object(
    'reference', v_sub.reference,
    'plan', private.effective_plan(p_business),
    'subscribed_plan', v_sub.plan,
    'status', v_sub.status,
    'current_period_end', v_sub.current_period_end,
    'payment_method', v_sub.payment_method,
    'discount_cycles_remaining', v_sub.discount_cycles_remaining,
    'discount_pct', v_sub.discount_pct,
    'launch_discount_until', case when not v_paid then v_biz.created_at + interval '24 hours' end,
    'launch_discount_open', (not v_paid and now() < v_biz.created_at + interval '24 hours'),
    'history_days', private.history_days(p_business)
  );
end $$;

-- Admin: accounts with their reference, last payment and paid status
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Not found' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.reference)
    from (
      select b.id, b.name, b.created_at, b.status as business_status,
        s.reference,
        (select u.email from public.memberships m join auth.users u on u.id = m.user_id
          where m.business_id = b.id and m.role = 'owner' order by m.created_at limit 1) as owner_email,
        s.plan, s.status, s.current_period_end, s.payment_method, s.discount_cycles_remaining,
        private.effective_plan(b.id) as effective_plan,
        private.plan_price(s.plan) as list_price,
        (select count(*) from public.memberships m where m.business_id = b.id and m.active) as team,
        (select count(*) from public.locations l where l.business_id = b.id and l.active) as locations,
        (select count(*) from public.products p where p.business_id = b.id and p.active) as products,
        (select count(*) from public.shifts sh where sh.business_id = b.id and sh.closing_submitted_at > now() - interval '30 days') as shifts_30d,
        (select max(sh.closing_submitted_at) from public.shifts sh where sh.business_id = b.id) as last_shift_at,
        (select count(*) from public.exceptions e where e.business_id = b.id and e.status in ('open', 'explained')) as open_alerts,
        (select coalesce(sum(i.amount), 0) from public.invoices i where i.business_id = b.id and i.status = 'paid') as total_paid,
        (select max(i.paid_at) from public.invoices i where i.business_id = b.id and i.status = 'paid') as last_paid_at
      from public.businesses b
      left join public.subscriptions s on s.business_id = b.id
    ) x
  ), '[]'::jsonb);
end $$;

-- Admin: payments, newest first ('all', 'paid', 'failed', 'pending')
create or replace function public.admin_invoices(p_status text default 'all')
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Not found' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'subscription_ref', i.subscription_ref, 'business', b.name, 'plan', i.plan,
      'reference', i.reference, 'amount', i.amount, 'discount_pct', i.discount_pct, 'status', i.status,
      'created_at', i.created_at, 'paid_at', i.paid_at) order by i.created_at desc)
    from (select * from public.invoices where (p_status = 'all' and status <> 'void') or status = p_status
          order by created_at desc limit 200) i
    join public.businesses b on b.id = i.business_id
  ), '[]'::jsonb);
end $$;

-- Manual EFT marking is no longer offered
revoke execute on function public.admin_mark_invoice_paid(uuid) from authenticated;


-- ===== 20261011000010_dispensary_catalogue.sql =====
-- Sample catalogue for a new dispensary, modelled on a typical South African
-- private members' club menu: flower by the gram, pre-rolls, edibles, vapes and
-- extracts, plus the two usual pre-roll specials. Owners edit or remove these.
--
-- Also: signing up twice (or opening the setup page twice) no longer creates a
-- second shop for the same owner.

create or replace function public.load_demo_catalogue(p_business uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_count int := 0; r record; v_id uuid; v_special uuid;
begin
  if not private.is_owner(p_business) then
    raise exception 'Only the owner can load demo data' using errcode = '42501';
  end if;
  for r in select * from (values
    -- sku,      name,                                   mode,     base,   display, pos code, price per unit/gram, low-stock level
    ('FL-OUT',  'Outdoor flower: Gas Nana',               'weight', 'g',    'g',     'FL01',   30.00,  50),
    ('FL-EXO',  'Ex-outdoor flower: Grape Stank',         'weight', 'g',    'g',     'FL02',   35.00,  30),
    ('FL-BGH',  'B-greenhouse flower: Exodus Cheese',     'weight', 'g',    'g',     'FL03',   40.00,  30),
    ('FL-GH1',  'Greenhouse flower: Choc Haze',           'weight', 'g',    'g',     'FL04',   60.00,  20),
    ('FL-GH2',  'Greenhouse flower: Blunicorn',           'weight', 'g',    'g',     'FL05',   60.00,  20),
    ('FL-INA',  'Indoor A flower: UK Cheese',             'weight', 'g',    'g',     'FL06',  100.00,  15),
    ('FL-AAA',  'Indoor AAA flower: Orange Bubble Gum',   'weight', 'g',    'g',     'FL07',  150.00,  10),
    ('PR-GH1',  'Greenhouse pre-roll: Blue Cheese',       'unit',   'unit', 'unit',  'PR01',   60.00,   6),
    ('PR-GH2',  'Greenhouse pre-roll: Chemical Fruit',    'unit',   'unit', 'unit',  'PR02',   60.00,   6),
    ('PR-IN1',  'Indoor pre-roll: Blue Zushi',            'unit',   'unit', 'unit',  'PR03',  110.00,   4),
    ('PR-IN2',  'Indoor pre-roll: Black Berry',           'unit',   'unit', 'unit',  'PR04',  110.00,   4),
    ('ED-JAP',  'Jellies Apple, 10 pack (100mg)',         'unit',   'unit', 'unit',  'ED01',  130.00,   5),
    ('ED-JST',  'Jellies Strawberry, 10 pack (100mg)',    'unit',   'unit', 'unit',  'ED02',  130.00,   5),
    ('ED-JMA',  'Jellies Mango, 10 pack (200mg)',         'unit',   'unit', 'unit',  'ED03',  200.00,   5),
    ('ED-LOL',  'Lollie (100mg)',                         'unit',   'unit', 'unit',  'ED04',  100.00,   5),
    ('ED-CCC',  'Choc chip cookie (50mg)',                'unit',   'unit', 'unit',  'ED05',   60.00,   6),
    ('ED-BRW',  'Brownie (120mg)',                        'unit',   'unit', 'unit',  'ED06',  120.00,   4),
    ('VP-CRT',  '1ml vape cartridge',                     'unit',   'unit', 'unit',  'VP01',  300.00,   3),
    ('VP-DSP',  'Disposable vape pen',                    'unit',   'unit', 'unit',  'VP02',  520.00,   3),
    ('EX-ROS',  'Hash rosin, 1g',                         'unit',   'unit', 'unit',  'EX01',  600.00,   2)
  ) as t(sku, name, mode, base, display, code, price, low)
  loop
    insert into public.products (business_id, sku, name, tracking_mode, base_unit, display_unit, pos_code, low_stock_level)
    values (p_business, r.sku, r.name, r.mode::public.tracking_mode, r.base, r.display, r.code, r.low)
    on conflict (business_id, sku) do nothing
    returning id into v_id;
    if v_id is not null then
      insert into public.product_prices (product_id, unit_price, valid_from, created_by)
      values (v_id, r.price, now() - interval '1 day', auth.uid());
      v_count := v_count + 1;
    end if;
  end loop;

  -- The usual pre-roll deals
  if not exists (select 1 from public.specials where business_id = p_business and code = 'DEAL-IN2') then
    insert into public.specials (business_id, name, code, deal_price, items_per_deal)
    values (p_business, 'Indoor pre-rolls, 2 for R200', 'DEAL-IN2', 200, 2) returning id into v_special;
    insert into public.special_products (special_id, product_id)
      select v_special, p.id from public.products p where p.business_id = p_business and p.sku in ('PR-IN1', 'PR-IN2');
  end if;
  if not exists (select 1 from public.specials where business_id = p_business and code = 'DEAL-GH2') then
    insert into public.specials (business_id, name, code, deal_price, items_per_deal)
    values (p_business, 'Greenhouse pre-rolls, 2 for R100', 'DEAL-GH2', 100, 2) returning id into v_special;
    insert into public.special_products (special_id, product_id)
      select v_special, p.id from public.products p where p.business_id = p_business and p.sku in ('PR-GH1', 'PR-GH2');
  end if;
  return v_count;
end $$;
revoke execute on function public.load_demo_catalogue(uuid) from public, anon;
grant execute on function public.load_demo_catalogue(uuid) to authenticated;

-- One shop per owner account: a repeated sign-up returns the existing shop
create or replace function public.create_business(p_name text, p_location_name text default 'Main store', p_standard_float numeric default 500)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_biz uuid; v_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Enter your business name' using errcode = '22023';
  end if;
  select m.business_id into v_biz from public.memberships m
   where m.user_id = auth.uid() and m.role = 'owner' and m.active order by m.created_at limit 1;
  if v_biz is not null then return v_biz; end if;

  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;
  select email into v_email from auth.users where id = auth.uid();

  insert into public.businesses (name) values (trim(p_name)) returning id into v_biz;
  insert into public.locations (business_id, name, standard_float)
    values (v_biz, coalesce(nullif(trim(p_location_name), ''), 'Main store'), greatest(coalesce(p_standard_float, 0), 0));
  insert into public.memberships (business_id, user_id, role) values (v_biz, auth.uid(), 'owner');
  insert into public.subscriptions (business_id, plan, status, current_period_end, billing_email)
    values (v_biz, 'business', 'trialing', now() + interval '3 days', v_email);
  return v_biz;
end $$;
revoke execute on function public.create_business(text, text, numeric) from public, anon;
grant execute on function public.create_business(text, text, numeric) to authenticated;


-- 20261011000011_generic_catalogue.sql
-- Sample catalogue made generic: common strain names, rounded market prices and
-- pre-roll specials, so it isn't any one shop's menu. Owners edit or remove these.

create or replace function public.load_demo_catalogue(p_business uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_count int := 0; r record; v_id uuid; v_special uuid;
begin
  if not private.is_owner(p_business) then
    raise exception 'Only the owner can load demo data' using errcode = '42501';
  end if;
  for r in select * from (values
    -- sku,      name,                                   mode,     base,   display, pos code, price per unit/gram, low-stock level
    ('FL-OUT',  'Outdoor flower: House Blend',            'weight', 'g',    'g',     'FL01',   25.00,  50),
    ('FL-EXO',  'Ex-outdoor flower: Purple Kush',         'weight', 'g',    'g',     'FL02',   35.00,  30),
    ('FL-BGH',  'B-greenhouse flower: Lemon Haze',        'weight', 'g',    'g',     'FL03',   45.00,  30),
    ('FL-GH1',  'Greenhouse flower: Gelato',              'weight', 'g',    'g',     'FL04',   55.00,  20),
    ('FL-GH2',  'Greenhouse flower: Northern Lights',     'weight', 'g',    'g',     'FL05',   55.00,  20),
    ('FL-INA',  'Indoor A flower: Wedding Cake',          'weight', 'g',    'g',     'FL06',   90.00,  15),
    ('FL-AAA',  'Indoor AAA flower: Runtz',               'weight', 'g',    'g',     'FL07',  140.00,  10),
    ('PR-GH1',  'Greenhouse pre-roll: Gelato',            'unit',   'unit', 'unit',  'PR01',   50.00,   6),
    ('PR-GH2',  'Greenhouse pre-roll: Northern Lights',   'unit',   'unit', 'unit',  'PR02',   50.00,   6),
    ('PR-IN1',  'Indoor pre-roll: Wedding Cake',          'unit',   'unit', 'unit',  'PR03',  100.00,   4),
    ('PR-IN2',  'Indoor pre-roll: Runtz',                 'unit',   'unit', 'unit',  'PR04',  100.00,   4),
    ('ED-GUM',  'Gummies, 10 pack (100mg)',               'unit',   'unit', 'unit',  'ED01',  120.00,   5),
    ('ED-GUS',  'Sour gummies, 10 pack (100mg)',          'unit',   'unit', 'unit',  'ED02',  120.00,   5),
    ('ED-GUX',  'Gummies extra strength, 10 pack (200mg)','unit',   'unit', 'unit',  'ED03',  190.00,   5),
    ('ED-LOL',  'Lollipop (100mg)',                       'unit',   'unit', 'unit',  'ED04',   90.00,   5),
    ('ED-CKE',  'Cookie (50mg)',                          'unit',   'unit', 'unit',  'ED05',   55.00,   6),
    ('ED-BRW',  'Brownie (100mg)',                        'unit',   'unit', 'unit',  'ED06',  110.00,   4),
    ('VP-CRT',  '1ml vape cartridge',                     'unit',   'unit', 'unit',  'VP01',  280.00,   3),
    ('VP-DSP',  'Disposable vape pen',                    'unit',   'unit', 'unit',  'VP02',  480.00,   3),
    ('EX-ROS',  'Rosin, 1g',                              'unit',   'unit', 'unit',  'EX01',  550.00,   2)
  ) as t(sku, name, mode, base, display, code, price, low)
  loop
    insert into public.products (business_id, sku, name, tracking_mode, base_unit, display_unit, pos_code, low_stock_level)
    values (p_business, r.sku, r.name, r.mode::public.tracking_mode, r.base, r.display, r.code, r.low)
    on conflict (business_id, sku) do nothing
    returning id into v_id;
    if v_id is not null then
      insert into public.product_prices (product_id, unit_price, valid_from, created_by)
      values (v_id, r.price, now() - interval '1 day', auth.uid());
      v_count := v_count + 1;
    end if;
  end loop;

  -- The usual pre-roll deals
  if not exists (select 1 from public.specials where business_id = p_business and code = 'DEAL-IN2') then
    insert into public.specials (business_id, name, code, deal_price, items_per_deal)
    values (p_business, 'Indoor pre-rolls, 2 for R180', 'DEAL-IN2', 180, 2) returning id into v_special;
    insert into public.special_products (special_id, product_id)
      select v_special, p.id from public.products p where p.business_id = p_business and p.sku in ('PR-IN1', 'PR-IN2');
  end if;
  if not exists (select 1 from public.specials where business_id = p_business and code = 'DEAL-GH2') then
    insert into public.specials (business_id, name, code, deal_price, items_per_deal)
    values (p_business, 'Greenhouse pre-rolls, 2 for R90', 'DEAL-GH2', 90, 2) returning id into v_special;
    insert into public.special_products (special_id, product_id)
      select v_special, p.id from public.products p where p.business_id = p_business and p.sku in ('PR-GH1', 'PR-GH2');
  end if;
  return v_count;
end $$;
revoke execute on function public.load_demo_catalogue(uuid) from public, anon;
grant execute on function public.load_demo_catalogue(uuid) to authenticated;



-- 20261011000012_trial_emails.sql
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


-- 20261011000013_monthly_insights.sql
-- Monthly report, business view: sales trends, what customers buy and when,
-- stock that runs low or sits, and where stock or cash didn't tally. The app
-- turns these figures into plain recommendations (lib/insights.ts).
-- Owners and managers on the Business or Multi-site plan.

create or replace function public.monthly_insights(p_business uuid, p_days int default 30)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_from timestamptz := now() - make_interval(days => p_days);
  v_prev timestamptz := now() - make_interval(days => p_days * 2);
  v jsonb;
begin
  if not private.is_manager(p_business) then
    raise exception 'Only owners and managers can see the monthly report' using errcode = '42501';
  end if;
  if private.effective_plan(p_business) not in ('business', 'multi_site') then
    raise exception 'The monthly report is part of the Business plan' using errcode = 'P0001';
  end if;

  with
  cur_shifts as (
    select id, opened_at from public.shifts
    where business_id = p_business and opened_at >= v_from and status not in ('opening', 'active')
  ),
  prev_shifts as (
    select id from public.shifts
    where business_id = p_business and opened_at >= v_prev and opened_at < v_from and status not in ('opening', 'active')
  ),
  lines as (
    select l.*, (l.gross_amount - l.discount_amount) as net,
      (l.transaction_at at time zone 'Africa/Johannesburg') as local_at
    from public.pos_sales_lines l join cur_shifts s on s.id = l.shift_id
    where not l.is_void
  ),
  prev_lines as (
    select l.product_id, l.quantity, (l.gross_amount - l.discount_amount) as net
    from public.pos_sales_lines l join prev_shifts s on s.id = l.shift_id
    where not l.is_void
  ),
  closing as (  -- latest closing count per product per shift
    select distinct on (c.shift_id, c.product_id) c.shift_id, c.product_id, c.quantity, s.opened_at
    from public.stock_counts c join cur_shifts s on s.id = c.shift_id
    where c.count_type = 'closing'
    order by c.shift_id, c.product_id, c.version desc
  ),
  latest_on_hand as (
    select distinct on (product_id) product_id, quantity from closing order by product_id, opened_at desc
  ),
  diffs as (
    select e.product_id, e.difference, e.shift_id, s.opened_at
    from public.exceptions e join cur_shifts s on s.id = e.shift_id
    where e.exception_type = 'stock_variance' and e.stage = 'closing' and e.status <> 'superseded' and e.difference < 0
  ),
  price as (
    select product_id, unit_price from public.product_prices where valid_to is null
  ),
  prod as (
    select p.id, p.name, p.base_unit, p.low_stock_level,
      coalesce((select sum(quantity) from lines where product_id = p.id), 0) as qty,
      coalesce((select sum(net) from lines where product_id = p.id), 0) as sales,
      coalesce((select sum(quantity) from prev_lines where product_id = p.id), 0) as prev_qty,
      (select count(*) from closing c where c.product_id = p.id and p.low_stock_level > 0 and c.quantity <= p.low_stock_level) as low_shifts,
      (select count(*) from closing c where c.product_id = p.id and c.quantity = 0) as out_shifts,
      (select quantity from latest_on_hand o where o.product_id = p.id) as on_hand,
      coalesce((select sum(-difference) from diffs d where d.product_id = p.id), 0) as diff_qty,
      coalesce((select sum(-difference) from diffs d where d.product_id = p.id), 0) * coalesce((select unit_price from price where product_id = p.id), 0) as diff_value,
      (select count(distinct shift_id) from diffs d where d.product_id = p.id) as diff_shifts
    from public.products p
    where p.business_id = p_business and p.active
  )
  select jsonb_build_object(
    'days', p_days,
    'shifts_closed', (select count(*) from cur_shifts),
    'sales_total', coalesce((select sum(net) from lines), 0),
    'prev_sales_total', coalesce((select sum(net) from prev_lines), 0),
    'card_share', coalesce((select sum(net) filter (where payment_method = 'card') / nullif(sum(net), 0) from lines), 0),
    'by_dow', (select jsonb_agg(jsonb_build_object('dow', d, 'sales',
                 coalesce((select sum(net) from lines where extract(dow from local_at) = d), 0)) order by d)
               from generate_series(0, 6) d),
    'by_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'sales', s) order by h)
               from (select extract(hour from local_at)::int h, sum(net) s from lines group by 1) x), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
                 'name', name, 'unit', base_unit, 'qty', qty, 'sales', sales, 'prev_qty', prev_qty,
                 'low_shifts', low_shifts, 'out_shifts', out_shifts, 'on_hand', on_hand,
                 'diff_qty', diff_qty, 'diff_value', round(diff_value, 2), 'diff_shifts', diff_shifts) order by sales desc)
               from prod), '[]'::jsonb),
    'specials', coalesce((select jsonb_agg(jsonb_build_object('name', sp.name, 'deals', t.deals, 'revenue', t.deals * sp.deal_price) order by t.deals desc)
               from (select ss.special_id, sum(ss.deals) deals from public.special_sales ss join cur_shifts s on s.id = ss.shift_id group by 1) t
               join public.specials sp on sp.id = t.special_id), '[]'::jsonb),
    'diff_by_dow', (select jsonb_agg(jsonb_build_object('dow', d, 'value',
                 coalesce((select sum(-df.difference * coalesce(pr.unit_price, 0)) from diffs df left join price pr on pr.product_id = df.product_id
                           where extract(dow from df.opened_at at time zone 'Africa/Johannesburg') = d), 0)) order by d)
               from generate_series(0, 6) d),
    'cash_short_total', coalesce((select sum(-e.difference) from public.exceptions e join cur_shifts s on s.id = e.shift_id
               where e.exception_type = 'cash_variance' and e.stage = 'closing' and e.status <> 'superseded' and e.difference < 0), 0),
    'cash_short_shifts', (select count(distinct e.shift_id) from public.exceptions e join cur_shifts s on s.id = e.shift_id
               where e.exception_type = 'cash_variance' and e.stage = 'closing' and e.status <> 'superseded' and e.difference < 0)
  ) into v;
  return v;
end $$;

revoke execute on function public.monthly_insights(uuid, int) from public, anon;
grant execute on function public.monthly_insights(uuid, int) to authenticated;


-- 20261011000014_any_till.sql
-- Any till file, and shops with no till file at all.
--
-- 1. businesses.pos_layout remembers how this shop's till export is laid out
--    (which column is which) and which till items are which products, so the
--    owner only confirms it once (lib/pos/smart.ts reads the file).
-- 2. businesses.sales_source = 'counts' for shops that don't upload a till
--    file: at close, what was sold is worked out from the stock counts, priced
--    at the shop's prices, and compared with the cash and card actually taken.

alter table public.businesses add column if not exists pos_layout jsonb not null default '{}'::jsonb;
alter table public.businesses add column if not exists sales_source text not null default 'till';
alter table public.businesses drop constraint if exists businesses_sales_source_check;
alter table public.businesses add constraint businesses_sales_source_check check (sales_source in ('till', 'counts'));

create or replace function public.set_pos_layout(p_business uuid, p_layout jsonb)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_manager(p_business) then
    raise exception 'Only managers and owners can change how till files are read' using errcode = '42501';
  end if;
  if jsonb_typeof(p_layout) <> 'object' or length(p_layout::text) > 200000 then
    raise exception 'Layout not valid' using errcode = '22023';
  end if;
  update public.businesses set pos_layout = p_layout where id = p_business;
end $$;

create or replace function public.set_sales_source(p_business uuid, p_source text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_owner(p_business) then
    raise exception 'Only the owner can change this' using errcode = '42501';
  end if;
  if p_source not in ('till', 'counts') then
    raise exception 'Choose till or counts' using errcode = '22023';
  end if;
  update public.businesses set sales_source = p_source where id = p_business;
end $$;

-- Called from submit_closing (inside its workflow) for 'counts' shops.
-- Sold = opening + received - moved out - closing count, less anything already
-- recorded as specials. Each product's sale is priced at the shop's price.
-- The money expected is then split: card = the card machine total (up to the
-- value), cash = the rest, so the cash check compares money with stock.
create or replace function private.counts_sales(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_shift  public.shifts%rowtype;
  v_import uuid;
  v_tag    text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  v_total  numeric;
  v_rows   int;
  v_card   numeric;
begin
  select * into v_shift from public.shifts where id = p_shift;

  -- A resubmitted close replaces the earlier calculation
  update public.pos_sales_lines set is_void = true
   where shift_id = p_shift and not is_void
     and import_id in (select id from public.pos_imports where shift_id = p_shift and source = 'counts');
  update public.pos_imports set status = 'superseded'
   where shift_id = p_shift and source = 'counts' and status = 'validated';

  insert into public.pos_imports (business_id, location_id, shift_id, source, file_name, file_sha256, row_count, pos_total_sales, imported_by)
  values (v_shift.business_id, v_shift.location_id, p_shift, 'counts', 'Worked out from stock counts',
          encode(sha256(convert_to(p_shift::text || v_tag, 'UTF8')), 'hex'), 0, 0, auth.uid())
  returning id into v_import;

  with latest as (
    select distinct on (product_id, count_type) product_id, count_type, quantity
    from public.stock_counts where shift_id = p_shift
    order by product_id, count_type, version desc
  ),
  mv as (
    select product_id,
      sum(quantity) filter (where movement_type in ('RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT')) as added,
      sum(quantity) filter (where movement_type in ('TRANSFER_OUT', 'WASTAGE', 'DAMAGE', 'INTERNAL_USE')) as removed
    from public.stock_movements where shift_id = p_shift group by product_id
  ),
  sp as (
    select product_id, sum(quantity) as qty from public.pos_sales_lines
    where shift_id = p_shift and not is_void and product_id is not null group by product_id
  ),
  used as (
    select p.id, coalesce(p.pos_code, p.sku) as code,
      o.quantity + coalesce(mv.added, 0) - coalesce(mv.removed, 0) - c.quantity - coalesce(sp.qty, 0) as qty
    from public.products p
    join latest o on o.product_id = p.id and o.count_type = 'opening'
    join latest c on c.product_id = p.id and c.count_type = 'closing'
    left join mv on mv.product_id = p.id
    left join sp on sp.product_id = p.id
    where p.business_id = v_shift.business_id
  )
  insert into public.pos_sales_lines (business_id, import_id, shift_id, external_ref, transaction_at, product_id, pos_code,
    quantity, gross_amount, discount_amount, tax_amount, payment_method)
  select v_shift.business_id, v_import, p_shift, 'counts-' || p_shift || '-' || u.id || '-' || v_tag, now(), u.id, u.code,
    u.qty, round(u.qty * private.price_at(u.id, now()), 2), 0, 0, 'other'
  from used u
  where u.qty > 0 and private.price_at(u.id, now()) is not null;
  get diagnostics v_rows = row_count;

  select coalesce(sum(gross_amount - discount_amount), 0) into v_total
  from public.pos_sales_lines where shift_id = p_shift and not is_void and not is_refund;

  update public.pos_imports set row_count = v_rows,
    pos_total_sales = (select coalesce(sum(gross_amount), 0) from public.pos_sales_lines where import_id = v_import)
   where id = v_import;

  v_card := least(coalesce(v_shift.card_machine_total, 0), v_total);
  update public.shifts set till_card_total = v_card, till_cash_total = v_total - v_card where id = p_shift;
end $$;

revoke execute on function private.counts_sales(uuid) from public, anon, authenticated;
revoke execute on function public.set_pos_layout(uuid, jsonb) from public, anon;
revoke execute on function public.set_sales_source(uuid, text) from public, anon;
grant execute on function public.set_pos_layout(uuid, jsonb) to authenticated;
grant execute on function public.set_sales_source(uuid, text) to authenticated;

create or replace function public.submit_closing(
  p_shift uuid,
  p_counted_cash numeric,
  p_checklist jsonb,
  p_notes text,
  p_card_machine_total numeric default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift   public.shifts%rowtype;
  v_missing int;
  v_recon   jsonb;
  v_version int;
  r         jsonb;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found or not private.can_access_shift(p_shift) then
    raise exception 'Shift not found' using errcode = 'P0002';
  end if;
  if v_shift.status not in ('active', 'correction_requested') then
    raise exception 'Shift cannot be submitted from status %', v_shift.status using errcode = 'P0001';
  end if;
  if p_card_machine_total is not null and p_card_machine_total < 0 then
    raise exception 'Card machine total must be zero or more' using errcode = '22023';
  end if;
  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'Counted cash must be zero or more' using errcode = '22023';
  end if;

  select count(*) into v_missing
  from public.products p
  where p.business_id = v_shift.business_id and p.active
    and not exists (select 1 from public.stock_counts c
                    where c.shift_id = p_shift and c.product_id = p.id and c.count_type = 'closing');
  if v_missing > 0 then
    raise exception '% product(s) still need a closing count', v_missing using errcode = 'P0001';
  end if;

  perform private.begin_workflow();

  -- A resubmission replaces the previous closing exceptions that are still open
  update public.exceptions
     set status = 'superseded', explanation = coalesce(explanation, 'Replaced by resubmitted close'),
         resolved_by = auth.uid(), resolved_at = now()
   where shift_id = p_shift and stage = 'closing' and status = 'open';

  update public.shifts
     set counted_closing_cash = round(p_counted_cash, 2),
         card_machine_total = round(p_card_machine_total, 2),
         closed_by = auth.uid(),
         closing_submitted_at = now(),
         status = 'closing_submitted'
   where id = p_shift;

  insert into public.handover_checklists (business_id, shift_id, submitted_by, checklist_data, notes)
  values (v_shift.business_id, p_shift, auth.uid(), coalesce(p_checklist, '{}'::jsonb), p_notes);

  -- Shops without a till file: what was sold is worked out from the counts
  if (select sales_source from public.businesses where id = v_shift.business_id) = 'counts' then
    perform private.counts_sales(p_shift);
  end if;

  -- Compute with full visibility (this function is the system, not the caller)
  v_recon := public.shift_reconciliation(p_shift);
  if not (v_recon ->> 'money_visible')::boolean then
    -- Staff submitting their own shift always have money visibility (they closed it),
    -- so this should not happen; guard anyway.
    raise exception 'Reconciliation unavailable' using errcode = 'P0001';
  end if;

  select coalesce(max(version), 0) + 1 into v_version from public.payment_reconciliations where shift_id = p_shift;

  -- Cash snapshot
  insert into public.payment_reconciliations (business_id, shift_id, payment_method, expected_amount,
         actual_amount, difference, status, calculation, version)
  values (v_shift.business_id, p_shift, 'cash',
          (v_recon #>> '{cash,expected}')::numeric,
          (v_recon #>> '{cash,counted}')::numeric,
          (v_recon #>> '{cash,variance}')::numeric,
          (v_recon #>> '{cash,status}')::public.recon_status,
          v_recon -> 'cash', v_version);

  if v_recon #>> '{cash,status}' = 'variance' then
    insert into public.exceptions (business_id, shift_id, exception_type, payment_method, expected, actual, difference, severity, explanation)
    values (v_shift.business_id, p_shift, 'cash_variance', 'cash',
            (v_recon #>> '{cash,expected}')::numeric, (v_recon #>> '{cash,counted}')::numeric,
            (v_recon #>> '{cash,variance}')::numeric, 'high',
            case when (select sales_source from public.businesses where id = v_shift.business_id) = 'counts'
                 then 'Money taken (cash and card) compared with the value of the stock that left the shelf' end);
  end if;

  -- Settlement snapshots
  for r in select * from jsonb_array_elements(v_recon -> 'settlements') loop
    insert into public.payment_reconciliations (business_id, shift_id, payment_method, expected_amount,
           actual_amount, difference, status, calculation, version)
    values (v_shift.business_id, p_shift, (r ->> 'method')::public.payment_method,
            coalesce((r ->> 'expected_net')::numeric, (r ->> 'pos_expected')::numeric),
            (r ->> 'net')::numeric, (r ->> 'variance')::numeric,
            (r ->> 'status')::public.recon_status, r, v_version);

    if r ->> 'status' = 'variance' then
      insert into public.exceptions (business_id, shift_id, exception_type, payment_method, expected, actual, difference, severity)
      values (v_shift.business_id, p_shift, 'settlement_variance', (r ->> 'method')::public.payment_method,
              (r ->> 'expected_net')::numeric, (r ->> 'net')::numeric, (r ->> 'variance')::numeric, 'review');
    end if;
  end loop;

  -- Stock exceptions
  insert into public.exceptions (business_id, shift_id, exception_type, product_id, expected, actual, difference, severity)
  select v_shift.business_id, p_shift,
         case when s ->> 'status' = 'variance' then 'stock_variance' else 'missing_evidence' end::public.exception_type,
         (s ->> 'product_id')::uuid,
         (s ->> 'expected_closing')::numeric, (s ->> 'counted_closing')::numeric, (s ->> 'variance')::numeric,
         'review'
  from jsonb_array_elements(v_recon -> 'stock') s
  where s ->> 'status' in ('variance', 'missing_evidence');

  -- Sales value and evidence gaps
  if (v_recon #>> '{sales,import_count}')::int = 0 then
    insert into public.exceptions (business_id, shift_id, exception_type, severity, explanation)
    values (v_shift.business_id, p_shift, 'missing_evidence', 'high', 'No POS export was imported for this shift');
  end if;
  if (v_recon #>> '{sales,unmapped_lines}')::int > 0 or (v_recon #>> '{sales,unpriced_lines}')::int > 0 then
    insert into public.exceptions (business_id, shift_id, exception_type, severity, explanation)
    values (v_shift.business_id, p_shift, 'missing_evidence', 'review',
            format('%s POS line(s) not mapped to a product, %s without a price',
                   v_recon #>> '{sales,unmapped_lines}', v_recon #>> '{sales,unpriced_lines}'));
  end if;
  if (v_recon #>> '{sales,sales_value_variance}')::numeric <> 0 then
    insert into public.exceptions (business_id, shift_id, exception_type, expected, actual, difference, severity)
    values (v_shift.business_id, p_shift, 'sales_value_variance',
            (v_recon #>> '{sales,calculated_at_list}')::numeric, (v_recon #>> '{sales,pos_gross_mapped}')::numeric,
            (v_recon #>> '{sales,sales_value_variance}')::numeric, 'info');
  end if;

  -- Went into minus: the till sold more than was in stock
  insert into public.exceptions (business_id, shift_id, exception_type, product_id, expected, actual, difference, severity, explanation)
  select v_shift.business_id, p_shift, 'went_into_minus', (s ->> 'product_id')::uuid,
         0, (s ->> 'expected_closing')::numeric, (s ->> 'expected_closing')::numeric, 'high',
         'More was sold than was in stock. A delivery may not have been logged.'
  from jsonb_array_elements(v_recon -> 'stock') s
  where (s ->> 'went_into_minus')::boolean;

  -- Specials that don't add up: deals × items per deal ≠ items that went out
  insert into public.exceptions (business_id, shift_id, exception_type, expected, actual, difference, severity, explanation)
  select v_shift.business_id, p_shift, 'special_mismatch',
         (x ->> 'should_units')::numeric, (x ->> 'units')::numeric, (x ->> 'extra')::numeric, 'high',
         format('%s: %s deals should be %s items, %s went out', x ->> 'name', x ->> 'deals', x ->> 'should_units', x ->> 'units')
  from jsonb_array_elements(v_recon -> 'specials') x
  where (x ->> 'extra')::numeric <> 0;

  -- Running low for the next shift
  insert into public.exceptions (business_id, shift_id, exception_type, product_id, expected, actual, difference, severity)
  select v_shift.business_id, p_shift, 'low_stock', (s ->> 'product_id')::uuid,
         (s ->> 'low_stock_level')::numeric, (s ->> 'counted_closing')::numeric, null, 'info'
  from jsonb_array_elements(v_recon -> 'stock') s
  where (s ->> 'low_next')::boolean;

  perform private.end_workflow();
  return v_recon;
end $$;

revoke execute on function public.submit_closing(uuid, numeric, jsonb, text, numeric) from public, anon;
grant execute on function public.submit_closing(uuid, numeric, jsonb, text, numeric) to authenticated;


-- 20261011000015_categories.sql
-- Product categories (Flower, Pre-rolls, Edibles, ...) for the product list,
-- uploads and reports. Sample-menu products get theirs from the SKU prefix.
alter table public.products add column if not exists category text;
alter table public.products drop constraint if exists products_category_len;
alter table public.products add constraint products_category_len check (category is null or length(category) <= 40);

create or replace function private.product_category_default()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.category is null or btrim(new.category) = '' then
    new.category := case
      when new.sku like 'FL-%' then 'Flower'
      when new.sku like 'PR-%' then 'Pre-rolls'
      when new.sku like 'ED-%' then 'Edibles'
      when new.sku like 'VP-%' or new.sku like 'EX-%' then 'Vapes & extracts'
      else null end;
  else
    new.category := btrim(new.category);
  end if;
  return new;
end $$;

drop trigger if exists products_category_default on public.products;
create trigger products_category_default before insert or update of category on public.products
  for each row execute function private.product_category_default();

update public.products set category = case
  when sku like 'FL-%' then 'Flower' when sku like 'PR-%' then 'Pre-rolls' when sku like 'ED-%' then 'Edibles'
  when sku like 'VP-%' or sku like 'EX-%' then 'Vapes & extracts' end
where category is null and (sku like 'FL-%' or sku like 'PR-%' or sku like 'ED-%' or sku like 'VP-%' or sku like 'EX-%');

-- ===== 20261012000016_spot_checks =====
-- Spot-check counting, per-product allowances, and jar weights.
--
-- Spot-checks (businesses.count_mode = 'spot'): staff don't count every product
-- every shift. Opening stock is carried from the last close; at close OnPoint
-- picks a short list (always-count products, recent differences, products
-- not checked for a while, plus random ones) and the rest carry forward at
-- their expected level, marked as not counted. Cash and card are still
-- checked every shift. Needs sales from the till (not 'counts' mode).
--
-- Allowance (products.allowance_pct): a little extra given on weighed sales,
-- e.g. up to 5% more than was sold, doesn't raise a stock alert.
--
-- Jar weight (products.container_weight): staff weigh the whole jar and the
-- app subtracts the empty jar (done in the app before saving the count).

alter table public.businesses add column if not exists count_mode text not null default 'full';
alter table public.businesses add column if not exists spot_per_shift int not null default 12;
alter table public.businesses add column if not exists full_count_days int not null default 7;
alter table public.businesses drop constraint if exists businesses_count_mode_check;
alter table public.businesses add constraint businesses_count_mode_check check (count_mode in ('full', 'spot'));
alter table public.businesses drop constraint if exists businesses_spot_per_shift_check;
alter table public.businesses add constraint businesses_spot_per_shift_check check (spot_per_shift between 3 and 200);
alter table public.businesses drop constraint if exists businesses_full_count_days_check;
alter table public.businesses add constraint businesses_full_count_days_check check (full_count_days between 1 and 60);

alter table public.products add column if not exists always_count boolean not null default false;
alter table public.products add column if not exists allowance_pct numeric(5,2);
alter table public.products add column if not exists container_weight numeric(10,3);
alter table public.products drop constraint if exists products_allowance_pct_check;
alter table public.products add constraint products_allowance_pct_check check (allowance_pct is null or allowance_pct between 0 and 50);
alter table public.products drop constraint if exists products_container_weight_check;
alter table public.products add constraint products_container_weight_check check (container_weight is null or container_weight >= 0);

alter table public.stock_counts add column if not exists source text not null default 'counted';
alter table public.stock_counts drop constraint if exists stock_counts_source_check;
alter table public.stock_counts add constraint stock_counts_source_check check (source in ('counted', 'carried'));

alter table public.shifts add column if not exists full_count boolean not null default false;

create table if not exists public.shift_count_list (
  shift_id   uuid not null references public.shifts(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  reason     text not null,
  primary key (shift_id, product_id)
);
alter table public.shift_count_list enable row level security;
drop policy if exists count_list_select on public.shift_count_list;
create policy count_list_select on public.shift_count_list for select to authenticated
  using (private.can_access_shift(shift_id));

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create or replace function public.set_count_settings(p_business uuid, p_mode text, p_per_shift int, p_full_days int)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_owner(p_business) then
    raise exception 'Only the owner can change this' using errcode = '42501';
  end if;
  if p_mode not in ('full', 'spot') then raise exception 'Choose full or spot' using errcode = '22023'; end if;
  if p_mode = 'spot' and (select sales_source from public.businesses where id = p_business) = 'counts' then
    raise exception 'Spot-checks need your sales from the till. Switch “How sales get into OnPoint” to your till first.' using errcode = 'P0001';
  end if;
  update public.businesses
     set count_mode = p_mode,
         spot_per_shift = coalesce(p_per_shift, spot_per_shift),
         full_count_days = coalesce(p_full_days, full_count_days)
   where id = p_business;
end $$;

-- Working sales out from the counts needs every product counted
create or replace function public.set_sales_source(p_business uuid, p_source text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_owner(p_business) then
    raise exception 'Only the owner can change this' using errcode = '42501';
  end if;
  if p_source not in ('till', 'counts') then
    raise exception 'Choose till or counts' using errcode = '22023';
  end if;
  update public.businesses
     set sales_source = p_source,
         count_mode = case when p_source = 'counts' then 'full' else count_mode end
   where id = p_business;
end $$;

-- ---------------------------------------------------------------------------
-- Carry opening stock from the last close (spot mode)
-- ---------------------------------------------------------------------------
create or replace function private.carry_opening(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if v_shift.previous_shift_id is null then return; end if;
  insert into public.stock_counts (business_id, shift_id, product_id, count_type, quantity, version, submitted_by, source)
  select v_shift.business_id, p_shift, c.product_id, 'opening', c.quantity, 1, auth.uid(), 'carried'
  from (select distinct on (product_id) product_id, quantity from public.stock_counts
        where shift_id = v_shift.previous_shift_id and count_type = 'closing'
        order by product_id, version desc) c
  join public.products p on p.id = c.product_id and p.active
  where not exists (select 1 from public.stock_counts o where o.shift_id = p_shift and o.product_id = c.product_id and o.count_type = 'opening');
end $$;

-- ---------------------------------------------------------------------------
-- Pick what to count at close (spot mode)
-- ---------------------------------------------------------------------------
create or replace function private.pick_count_list(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype; v_biz public.businesses%rowtype; v_n int;
begin
  select * into v_shift from public.shifts where id = p_shift;
  select * into v_biz from public.businesses where id = v_shift.business_id;
  v_n := v_biz.spot_per_shift;

  -- Products the owner always wants counted
  insert into public.shift_count_list (shift_id, product_id, reason)
  select p_shift, p.id, 'Always counted' from public.products p
  where p.business_id = v_shift.business_id and p.active and p.always_count
  on conflict do nothing;

  -- Products that didn't tally recently
  insert into public.shift_count_list (shift_id, product_id, reason)
  select p_shift, x.product_id, 'Didn''t tally recently' from (
    select e.product_id, count(*) n from public.exceptions e
    join public.products p on p.id = e.product_id and p.active
    where e.business_id = v_shift.business_id and e.product_id is not null
      and e.exception_type in ('stock_variance', 'went_into_minus') and e.created_at > now() - interval '14 days'
    group by e.product_id order by n desc limit greatest(1, v_n / 3)
  ) x
  on conflict do nothing;

  -- Products not checked for a while (oldest first)
  insert into public.shift_count_list (shift_id, product_id, reason)
  select p_shift, y.id, 'Due for a check' from (
    select p.id, lc.t from public.products p
    left join lateral (select max(c.submitted_at) t from public.stock_counts c
                       where c.product_id = p.id and c.count_type = 'closing' and c.source = 'counted') lc on true
    where p.business_id = v_shift.business_id and p.active
      and (lc.t is null or lc.t < now() - make_interval(days => v_biz.full_count_days))
      and not exists (select 1 from public.shift_count_list l where l.shift_id = p_shift and l.product_id = p.id)
    order by lc.t nulls first
    limit greatest(0, v_n - (select count(*) from public.shift_count_list where shift_id = p_shift))
  ) y
  on conflict do nothing;

  -- A few at random, so nobody knows in advance what will be checked
  insert into public.shift_count_list (shift_id, product_id, reason)
  select p_shift, z.id, 'Random check' from (
    select p.id from public.products p
    where p.business_id = v_shift.business_id and p.active
      and not exists (select 1 from public.shift_count_list l where l.shift_id = p_shift and l.product_id = p.id)
    order by random()
    limit greatest(0, v_n - (select count(*) from public.shift_count_list where shift_id = p_shift))
  ) z
  on conflict do nothing;
end $$;

-- A manager can turn any shift into a full stock take
create or replace function public.request_full_count(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found or not private.can_access_shift(p_shift) then raise exception 'Shift not found' using errcode = 'P0002'; end if;
  if not private.is_manager(v_shift.business_id) then raise exception 'Only managers and owners can ask for a full count' using errcode = '42501'; end if;
  if v_shift.status not in ('active', 'correction_requested') then raise exception 'The shift is not open' using errcode = 'P0001'; end if;
  perform private.begin_workflow();
  insert into public.shift_count_list (shift_id, product_id, reason)
  select p_shift, p.id, 'Full count' from public.products p where p.business_id = v_shift.business_id and p.active
  on conflict do nothing;
  update public.shifts set full_count = true where id = p_shift;
  perform private.end_workflow();
end $$;

-- ---------------------------------------------------------------------------
-- Carry uncounted products forward at their expected level (spot mode)
-- ---------------------------------------------------------------------------
create or replace function private.carry_closing(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not exists (select 1 from public.shift_count_list where shift_id = p_shift) then return; end if;

  with latest as (
    select distinct on (product_id, count_type) product_id, count_type, quantity, version, source
    from public.stock_counts where shift_id = p_shift
    order by product_id, count_type, version desc
  ),
  mv as (
    select product_id,
      sum(quantity) filter (where movement_type in ('RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT')) as added,
      sum(quantity) filter (where movement_type in ('TRANSFER_OUT', 'WASTAGE', 'DAMAGE', 'INTERNAL_USE')) as removed
    from public.stock_movements where shift_id = p_shift group by product_id
  ),
  sold as (
    select product_id, sum(quantity) as qty from public.pos_sales_lines
    where shift_id = p_shift and not is_void and product_id is not null group by product_id
  ),
  target as (
    select p.id,
      greatest(0, o.quantity + coalesce(mv.added, 0) - coalesce(mv.removed, 0) - coalesce(sold.qty, 0)) as qty,
      c.quantity as cur_qty, c.version as cur_version, c.source as cur_source
    from public.products p
    join latest o on o.product_id = p.id and o.count_type = 'opening'
    left join latest c on c.product_id = p.id and c.count_type = 'closing'
    left join mv on mv.product_id = p.id
    left join sold on sold.product_id = p.id
    where p.business_id = v_shift.business_id and p.active
      and not exists (select 1 from public.shift_count_list l where l.shift_id = p_shift and l.product_id = p.id)
  )
  insert into public.stock_counts (business_id, shift_id, product_id, count_type, quantity, version, reason, submitted_by, source)
  select v_shift.business_id, p_shift, t.id, 'closing', t.qty, coalesce(t.cur_version, 0) + 1,
         case when t.cur_version is null then null else 'Recalculated (not counted this shift)' end, auth.uid(), 'carried'
  from target t
  where t.cur_version is null or (t.cur_source = 'carried' and t.cur_qty <> t.qty);
end $$;

revoke execute on function private.carry_opening(uuid) from public, anon, authenticated;
revoke execute on function private.pick_count_list(uuid) from public, anon, authenticated;
revoke execute on function private.carry_closing(uuid) from public, anon, authenticated;
revoke execute on function public.set_count_settings(uuid, text, int, int) from public, anon;
revoke execute on function public.request_full_count(uuid) from public, anon;
grant execute on function public.set_count_settings(uuid, text, int, int) to authenticated;
grant execute on function public.request_full_count(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Hook into the existing workflow functions (edited in place)
-- ---------------------------------------------------------------------------
do $$
declare src text;
begin
  -- open_shift: carry opening stock in spot mode
  src := pg_get_functiondef('public.open_shift(uuid, numeric)'::regprocedure);
  if position('returning id into v_id;' in src) = 0 then raise exception 'open_shift anchor missing'; end if;
  src := replace(src, 'returning id into v_id;', 'returning id into v_id;
  if (select count_mode from public.businesses where id = v_business) = ''spot'' then
    perform private.carry_opening(v_id);
  end if;');
  execute src;

  -- activate_shift: pick the close list in spot mode
  src := pg_get_functiondef('public.activate_shift(uuid)'::regprocedure);
  if position('update public.shifts set status = ''active'' where id = p_shift;' in src) = 0 then raise exception 'activate_shift anchor missing'; end if;
  src := replace(src, 'update public.shifts set status = ''active'' where id = p_shift;', 'if v_biz.count_mode = ''spot'' then
    perform private.pick_count_list(p_shift);
  end if;
  update public.shifts set status = ''active'' where id = p_shift;');
  execute src;

  -- submit_closing: only the list needs counting; the rest carry forward;
  -- explain stock differences on weighed products as extra given
  src := pg_get_functiondef('public.submit_closing(uuid, numeric, jsonb, text, numeric)'::regprocedure);
  if position('where c.shift_id = p_shift and c.product_id = p.id and c.count_type = ''closing'');' in src) = 0 then raise exception 'submit_closing anchor 1 missing'; end if;
  src := replace(src, 'where c.shift_id = p_shift and c.product_id = p.id and c.count_type = ''closing'');',
    'where c.shift_id = p_shift and c.product_id = p.id and c.count_type = ''closing'')
    and (not exists (select 1 from public.shift_count_list l where l.shift_id = p_shift)
         or exists (select 1 from public.shift_count_list l where l.shift_id = p_shift and l.product_id = p.id));');
  if position('  if (select sales_source from public.businesses where id = v_shift.business_id) = ''counts'' then' in src) = 0 then raise exception 'submit_closing anchor 2 missing'; end if;
  src := replace(src, '  if (select sales_source from public.businesses where id = v_shift.business_id) = ''counts'' then', '  perform private.carry_closing(p_shift);

  if (select sales_source from public.businesses where id = v_shift.business_id) = ''counts'' then');
  if position('''review''
  from jsonb_array_elements(v_recon -> ''stock'') s
  where s ->> ''status'' in (''variance'', ''missing_evidence'');' in src) = 0 then raise exception 'submit_closing anchor 3 missing'; end if;
  if position('insert into public.exceptions (business_id, shift_id, exception_type, product_id, expected, actual, difference, severity)
  select v_shift.business_id, p_shift,
         case when s ->> ''status'' = ''variance'' then ''stock_variance'' else ''missing_evidence'' end::public.exception_type,' in src) = 0 then raise exception 'submit_closing anchor 4 missing'; end if;
  src := replace(src, 'insert into public.exceptions (business_id, shift_id, exception_type, product_id, expected, actual, difference, severity)
  select v_shift.business_id, p_shift,
         case when s ->> ''status'' = ''variance'' then ''stock_variance'' else ''missing_evidence'' end::public.exception_type,',
    'insert into public.exceptions (business_id, shift_id, exception_type, product_id, expected, actual, difference, severity, explanation)
  select v_shift.business_id, p_shift,
         case when s ->> ''status'' = ''variance'' then ''stock_variance'' else ''missing_evidence'' end::public.exception_type,');
  src := replace(src, '''review''
  from jsonb_array_elements(v_recon -> ''stock'') s
  where s ->> ''status'' in (''variance'', ''missing_evidence'');',
    '''review'',
         case when s ->> ''status'' = ''variance'' and s ->> ''base_unit'' in (''g'', ''ml'')
                   and (s ->> ''variance'')::numeric < 0 and (s ->> ''net_sold'')::numeric > 0
              then format(''%s%% more than was sold left the stock: %s%s extra on %s%s sold'',
                          round(-(s ->> ''variance'')::numeric / (s ->> ''net_sold'')::numeric * 100),
                          round(-(s ->> ''variance'')::numeric, 1), s ->> ''base_unit'',
                          round((s ->> ''net_sold'')::numeric, 1), s ->> ''base_unit'') end
  from jsonb_array_elements(v_recon -> ''stock'') s
  where s ->> ''status'' in (''variance'', ''missing_evidence'');');
  execute src;

  -- shift_reconciliation: know which closing figures were counted, and apply allowances
  src := pg_get_functiondef('public.shift_reconciliation(uuid)'::regprocedure);
  if position('select distinct on (product_id, count_type) product_id, count_type, quantity
    from public.stock_counts
    where shift_id = p_shift' in src) = 0 then raise exception 'recon anchor 1 missing'; end if;
  src := replace(src, 'select distinct on (product_id, count_type) product_id, count_type, quantity
    from public.stock_counts
    where shift_id = p_shift', 'select distinct on (product_id, count_type) product_id, count_type, quantity, source
    from public.stock_counts
    where shift_id = p_shift');
  if position('cc.quantity as counted_closing,' in src) = 0 then raise exception 'recon anchor 2 missing'; end if;
  src := replace(src, 'cc.quantity as counted_closing,', 'cc.quantity as counted_closing,
      coalesce(cc.source, ''counted'') as closing_source, p.allowance_pct,');
  if position('''counted_closing'', c.counted_closing,' in src) = 0 then raise exception 'recon anchor 3 missing'; end if;
  src := replace(src, '''counted_closing'', c.counted_closing,', '''counted_closing'', c.counted_closing,
      ''counted'', c.closing_source = ''counted'',');
  if position('when c.opening is null or c.counted_closing is null then ''missing_evidence''
        when abs(c.counted_closing - c.expected_closing)
             <= abs(c.expected_closing) * v_biz.stock_tolerance_pct / 100 then ''matched''' in src) = 0 then raise exception 'recon anchor 4 missing'; end if;
  src := replace(src, 'when c.opening is null or c.counted_closing is null then ''missing_evidence''
        when abs(c.counted_closing - c.expected_closing)
             <= abs(c.expected_closing) * v_biz.stock_tolerance_pct / 100 then ''matched''',
    'when c.opening is null or c.counted_closing is null then ''missing_evidence''
        when c.closing_source = ''carried'' then ''not_counted''
        when abs(c.counted_closing - c.expected_closing)
             <= abs(c.expected_closing) * v_biz.stock_tolerance_pct / 100 then ''matched''
        when c.counted_closing < c.expected_closing and c.net_sold > 0
             and c.expected_closing - c.counted_closing <= c.net_sold * coalesce(c.allowance_pct, 0) / 100 then ''matched''');
  execute src;
end $$;

-- ===== 20261012000017_shared_counts =====
-- Shared counts: when several people are on site, the closing count list is
-- shared out at random between them, so nobody knows in advance what they'll
-- count and everyone counts something different each time. Each count is
-- already recorded under the person who entered it.
--
-- Works in both modes: in spot mode the picked list is shared; in full mode
-- every product goes on the list and is shared.

alter table public.shift_count_list add column if not exists assigned_to uuid references public.profiles(id);

create table if not exists public.shift_counters (
  shift_id uuid not null references public.shifts(id),
  user_id  uuid not null references public.profiles(id),
  added_by uuid not null references public.profiles(id),
  added_at timestamptz not null default now(),
  active   boolean not null default true,
  primary key (shift_id, user_id)
);
alter table public.shift_counters enable row level security;
create policy shift_counters_select on public.shift_counters for select to authenticated
  using (private.can_access_shift(shift_id));

-- Share the uncounted part of the list at random between the counters.
-- Items someone has already counted stay with them.
create or replace function private.share_count_list(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype; v_people uuid[]; v_n int;
begin
  select * into v_shift from public.shifts where id = p_shift;
  select array_agg(user_id order by random()) into v_people from public.shift_counters where shift_id = p_shift and active;
  v_n := coalesce(array_length(v_people, 1), 0);

  -- Full-count shops: the whole range is the list
  if not exists (select 1 from public.shift_count_list where shift_id = p_shift) then
    insert into public.shift_count_list (shift_id, product_id, reason)
    select p_shift, p.id, 'Full count' from public.products p
    where p.business_id = v_shift.business_id and p.active
    on conflict do nothing;
  end if;

  with open_items as (
    select l.product_id, row_number() over (order by random()) - 1 as rn
    from public.shift_count_list l
    where l.shift_id = p_shift
      and not exists (select 1 from public.stock_counts c
                      where c.shift_id = p_shift and c.product_id = l.product_id
                        and c.count_type = 'closing' and c.source = 'counted')
  )
  update public.shift_count_list l
     set assigned_to = case when v_n = 0 then null else v_people[(o.rn % v_n) + 1] end
    from open_items o
   where l.shift_id = p_shift and l.product_id = o.product_id;
end $$;

-- Someone on site joins the count
create or replace function public.join_count(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found or not private.can_access_shift(p_shift) then raise exception 'Shift not found' using errcode = 'P0002'; end if;
  if v_shift.status <> 'active' then raise exception 'You can join the count while the shift is open' using errcode = 'P0001'; end if;
  insert into public.shift_counters (shift_id, user_id, added_by) values (p_shift, auth.uid(), auth.uid())
  on conflict (shift_id, user_id) do update set active = true;
  perform private.share_count_list(p_shift);
end $$;

-- The person running the shift (or a manager) sets who is counting
create or replace function public.set_counters(p_shift uuid, p_users uuid[])
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found or not private.can_access_shift(p_shift) then raise exception 'Shift not found' using errcode = 'P0002'; end if;
  if v_shift.opened_by <> auth.uid() and not private.is_manager(v_shift.business_id) then
    raise exception 'Only the person running the shift or a manager can choose who counts' using errcode = '42501';
  end if;
  if v_shift.status <> 'active' then raise exception 'You can share the count while the shift is open' using errcode = 'P0001'; end if;
  if coalesce(array_length(p_users, 1), 0) > 30 then raise exception 'Too many people' using errcode = '22023'; end if;
  if exists (select 1 from unnest(coalesce(p_users, '{}')) u
             where not exists (select 1 from public.memberships m join public.profiles pr on pr.id = m.user_id
                               where m.business_id = v_shift.business_id and m.user_id = u and m.active and pr.active)) then
    raise exception 'Everyone counting must be on your team' using errcode = '22023';
  end if;
  update public.shift_counters set active = (user_id = any(coalesce(p_users, '{}'))) where shift_id = p_shift;
  insert into public.shift_counters (shift_id, user_id, added_by)
  select p_shift, u, auth.uid() from unnest(coalesce(p_users, '{}')) u
  on conflict (shift_id, user_id) do update set active = true;
  perform private.share_count_list(p_shift);
end $$;

-- Who is counting, how much each has, and how far along they are
create or replace function public.count_progress(p_shift uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_access_shift(p_shift) then raise exception 'Shift not found' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', sc.user_id,
      'name', coalesce(nullif(pr.full_name, ''), 'Team member'),
      'assigned', (select count(*) from public.shift_count_list l where l.shift_id = p_shift and l.assigned_to = sc.user_id),
      'counted', (select count(*) from public.shift_count_list l where l.shift_id = p_shift and l.assigned_to = sc.user_id
                  and exists (select 1 from public.stock_counts c where c.shift_id = p_shift and c.product_id = l.product_id
                              and c.count_type = 'closing' and c.source = 'counted'))
    ) order by sc.added_at)
    from public.shift_counters sc join public.profiles pr on pr.id = sc.user_id
    where sc.shift_id = p_shift and sc.active), '[]'::jsonb);
end $$;

-- A closing count on a shared list must come from the person it was given to
-- (managers can count anything; recounts after a correction request are open).
create or replace function private.check_count_assignment()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_to uuid; v_status public.shift_status;
begin
  if new.count_type <> 'closing' or new.source <> 'counted' or auth.uid() is null then return new; end if;
  select assigned_to into v_to from public.shift_count_list where shift_id = new.shift_id and product_id = new.product_id;
  if v_to is null or v_to = auth.uid() then return new; end if;
  select status into v_status from public.shifts where id = new.shift_id;
  if v_status = 'correction_requested' or private.is_manager(new.business_id) then return new; end if;
  raise exception 'That product is on someone else''s count list tonight' using errcode = '42501';
end $$;

create trigger counts_check_assignment before insert on public.stock_counts
  for each row execute function private.check_count_assignment();

revoke execute on function private.share_count_list(uuid) from public, anon, authenticated;
revoke execute on function public.join_count(uuid) from public, anon;
revoke execute on function public.set_counters(uuid, uuid[]) from public, anon;
revoke execute on function public.count_progress(uuid) from public, anon;
grant execute on function public.join_count(uuid) to authenticated;
grant execute on function public.set_counters(uuid, uuid[]) to authenticated;
grant execute on function public.count_progress(uuid) to authenticated;

-- ===== 20261012000018_shift_statements =====
-- End-of-shift statements: each person on shift answers three questions,
-- adds photos, and confirms with their own password. The owner sees every
-- statement on the shift and in the nightly email.
--
-- Rows are written only by the server after it has checked the person's
-- password (service role), so there is no insert policy for app users, and
-- no update policy: a statement can't be changed once given.

alter table public.businesses add column if not exists require_statement boolean not null default true;

create table if not exists public.shift_statements (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id),
  shift_id           uuid not null references public.shifts(id),
  user_id            uuid not null references public.profiles(id),
  unrung             boolean not null,
  unrung_detail      text check (length(unrung_detail) <= 1000),
  stock_event        boolean not null,
  stock_event_detail text check (length(stock_event_detail) <= 1000),
  notes              text check (length(notes) <= 1000),
  photos             text[] not null default '{}' check (cardinality(photos) <= 6),
  confirmed_with     text not null default 'password' check (confirmed_with = 'password'),
  created_at         timestamptz not null default now(),
  unique (shift_id, user_id),
  check (not unrung or length(coalesce(unrung_detail, '')) > 0),
  check (not stock_event or length(coalesce(stock_event_detail, '')) > 0)
);
alter table public.shift_statements enable row level security;

-- You see your own statements; managers and owners see everyone's
create policy statements_select on public.shift_statements for select to authenticated
  using (
    private.can_access_shift(shift_id)
    and (user_id = auth.uid() or private.is_manager(business_id))
  );

create or replace function public.set_require_statement(p_business uuid, p_on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_owner(p_business) then
    raise exception 'Only the owner can change this' using errcode = '42501';
  end if;
  update public.businesses set require_statement = coalesce(p_on, true) where id = p_business;
end $$;

revoke execute on function public.set_require_statement(uuid, boolean) from public, anon;
grant execute on function public.set_require_statement(uuid, boolean) to authenticated;

-- ===== 20261012000019_reprice =====
-- New list prices (rand per month): Starter R99, Business R499, Multi-site R999.
-- Keep in step with lib/plans.ts.
create or replace function private.plan_price(p_plan subscription_plan)
returns numeric language sql immutable as $$
  select case p_plan when 'starter' then 99 when 'business' then 499 when 'multi_site' then 999 else 0 end::numeric
$$;

-- ===== 20261012000020_high_value_checks =====
-- Spot-checks put high-value stock first: after the products that must be
-- counted (always-count, recently short), about a quarter of the
-- list goes to the stock worth the most on the shelf right now (selling
-- price x opening quantity), ahead of overdue products. The rest stays random.

create or replace function private.pick_count_list(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype; v_biz public.businesses%rowtype; v_n int;
begin
  select * into v_shift from public.shifts where id = p_shift;
  select * into v_biz from public.businesses where id = v_shift.business_id;
  v_n := v_biz.spot_per_shift;

  -- Products the owner always wants counted
  insert into public.shift_count_list (shift_id, product_id, reason)
  select p_shift, p.id, 'Always counted' from public.products p
  where p.business_id = v_shift.business_id and p.active and p.always_count
  on conflict do nothing;

  -- Products that didn't tally recently
  insert into public.shift_count_list (shift_id, product_id, reason)
  select p_shift, x.product_id, 'Didn''t tally recently' from (
    select e.product_id, count(*) n from public.exceptions e
    join public.products p on p.id = e.product_id and p.active
    where e.business_id = v_shift.business_id and e.product_id is not null
      and e.exception_type in ('stock_variance', 'went_into_minus') and e.created_at > now() - interval '14 days'
    group by e.product_id order by n desc limit greatest(1, v_n / 3)
  ) x
  on conflict do nothing;

  -- High-value stock: the most rand on the shelf
  insert into public.shift_count_list (shift_id, product_id, reason)
  select p_shift, h.id, 'High value' from (
    select p.id, o.quantity * coalesce(private.price_at(p.id, now()), 0) as worth
    from public.products p
    join lateral (select c.quantity from public.stock_counts c
                  where c.shift_id = p_shift and c.product_id = p.id and c.count_type = 'opening'
                  order by c.version desc limit 1) o on true
    where p.business_id = v_shift.business_id and p.active
      and not exists (select 1 from public.shift_count_list l where l.shift_id = p_shift and l.product_id = p.id)
    order by worth desc nulls last
    limit least(greatest(1, v_n / 4), greatest(0, v_n - (select count(*) from public.shift_count_list where shift_id = p_shift)))
  ) h
  where h.worth > 0
  on conflict do nothing;

  -- Products not checked for a while (oldest first)
  insert into public.shift_count_list (shift_id, product_id, reason)
  select p_shift, y.id, 'Due for a check' from (
    select p.id, lc.t from public.products p
    left join lateral (select max(c.submitted_at) t from public.stock_counts c
                       where c.product_id = p.id and c.count_type = 'closing' and c.source = 'counted') lc on true
    where p.business_id = v_shift.business_id and p.active
      and (lc.t is null or lc.t < now() - make_interval(days => v_biz.full_count_days))
      and not exists (select 1 from public.shift_count_list l where l.shift_id = p_shift and l.product_id = p.id)
    order by lc.t nulls first
    limit greatest(0, v_n - (select count(*) from public.shift_count_list where shift_id = p_shift))
  ) y
  on conflict do nothing;

  -- A few at random, so nobody knows in advance what will be checked
  insert into public.shift_count_list (shift_id, product_id, reason)
  select p_shift, z.id, 'Random check' from (
    select p.id from public.products p
    where p.business_id = v_shift.business_id and p.active
      and not exists (select 1 from public.shift_count_list l where l.shift_id = p_shift and l.product_id = p.id)
    order by random()
    limit greatest(0, v_n - (select count(*) from public.shift_count_list where shift_id = p_shift))
  ) z
  on conflict do nothing;
end $$;

revoke execute on function private.pick_count_list(uuid) from public, anon, authenticated;

-- ===== 20261012000021_staff_pins =====
-- Staff PINs: a 4–6 digit PIN per person to confirm their shift answers, so
-- people can confirm on a shared shop phone without typing a full password.
-- The PIN is hashed by the server (scrypt) and this table is readable and
-- writable only by the server (no policies for app users).

create table if not exists public.staff_pins (
  user_id      uuid primary key references public.profiles(id),
  pin_hash     text not null,
  failed       int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.staff_pins enable row level security;

-- Record how each statement was confirmed
alter table public.shift_statements add column if not exists pin_confirmed boolean not null default false;

-- ===== 20261012000022_pos_connections =====
-- POS connections: the access key a shop owner pastes in so OnPoint can read
-- sales and products from their POS (Loyverse first). Readable and writable
-- only by the server (service role): there are no policies for app users, and
-- the key is never sent to a browser.

create table if not exists public.pos_connections (
  business_id  uuid primary key references public.businesses(id),
  provider     text not null default 'loyverse' check (provider in ('loyverse')),
  token        text,
  store_id     text,
  store_name   text,
  connected_by uuid references public.profiles(id),
  connected_at timestamptz not null default now()
);
alter table public.pos_connections enable row level security;

-- What the app may show: whether a POS is connected (never the key)
create or replace function public.pos_connection(p_business uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select case when private.is_member(p_business) then (
    select jsonb_build_object('provider', c.provider, 'store_name', c.store_name, 'store_id', c.store_id, 'connected_at', c.connected_at)
    from public.pos_connections c where c.business_id = p_business and c.token is not null)
  end
$$;
revoke execute on function public.pos_connection(uuid) from public, anon;
grant execute on function public.pos_connection(uuid) to authenticated;

-- 20261012000023_bottles.sql
-- Bars and lounges: spirits are kept in ml and counted by weighing the open
-- bottle. The owner enters, once per product, the empty bottle's weight
-- (container_weight, already used for jars), a full sealed bottle's weight
-- and the bottle size in ml. The app turns a scale reading into ml:
--   ml = (reading - empty) * bottle_ml / (full - empty)
-- so no density table is needed and liqueurs work as well as spirits.
alter table public.products add column if not exists full_weight numeric(10,3) check (full_weight is null or full_weight > 0);
alter table public.products add column if not exists bottle_ml numeric(10,3) check (bottle_ml is null or bottle_ml > 0);

-- 20261012000024_demo_events.sql
-- Demo engagement: which personal demo links get opened and how far people go.
-- Written by /api/demo-event with the service role; read on the admin page.
-- No policies: the browser can't read or write this table directly.
create table if not exists public.demo_events (
  id         bigint generated always as identity primary key,
  shop       text not null check (length(shop) between 1 and 80),
  kind       text not null check (kind in ('dispensary', 'bar')),
  event      text not null check (event in ('open', 'staff', 'submit', 'report', 'signup')),
  visitor    text check (visitor is null or length(visitor) <= 40),
  mobile     boolean,
  created_at timestamptz not null default now()
);
alter table public.demo_events enable row level security;
create index if not exists demo_events_created_idx on public.demo_events (created_at desc);
revoke all on public.demo_events from anon, authenticated;
grant select, insert on public.demo_events to service_role;
