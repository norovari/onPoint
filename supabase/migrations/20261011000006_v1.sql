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

-- New businesses get the Business plan free for 14 days, then drop to Free.
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
    values (v_biz, 'business', 'trialing', now() + interval '14 days', v_email);
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
