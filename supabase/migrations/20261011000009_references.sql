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
