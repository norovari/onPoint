-- OnPoint — onboarding: create a business, add team members, demo catalogue

-- A signed-up user creates their business and becomes its owner (14-day trial).
create or replace function public.create_business(p_name text, p_location_name text, p_standard_float numeric default 500)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_biz uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_location_name), '') = '' then
    raise exception 'Business and location names are required' using errcode = '22023';
  end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;

  insert into public.businesses (name) values (trim(p_name)) returning id into v_biz;
  insert into public.locations (business_id, name, standard_float)
    values (v_biz, trim(p_location_name), greatest(coalesce(p_standard_float, 0), 0));
  insert into public.memberships (business_id, user_id, role) values (v_biz, auth.uid(), 'owner');
  insert into public.subscriptions (business_id, plan, status, current_period_end)
    values (v_biz, 'starter', 'trialing', now() + interval '14 days');
  return v_biz;
end $$;

-- Owner adds an existing OnPoint user (they must have signed up) to the team.
create or replace function public.add_member(
  p_business uuid, p_email text, p_role public.member_role, p_location_ids uuid[] default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_user uuid;
begin
  if not private.is_owner(p_business) then
    raise exception 'Only the owner can add team members' using errcode = '42501';
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No OnPoint account uses that email yet. Ask them to sign up first.' using errcode = 'P0002';
  end if;
  if p_location_ids is not null and exists (
    select 1 from unnest(p_location_ids) lid
    where not exists (select 1 from public.locations l where l.id = lid and l.business_id = p_business)
  ) then
    raise exception 'One or more locations do not belong to this business' using errcode = '22023';
  end if;
  insert into public.profiles (id) values (v_user) on conflict (id) do nothing;
  insert into public.memberships (business_id, user_id, role, location_ids, active)
  values (p_business, v_user, p_role, p_location_ids, true)
  on conflict (business_id, user_id) do update
    set role = excluded.role, location_ids = excluded.location_ids, active = true;
  return v_user;
end $$;

-- Deactivating a leaver keeps their history but removes access immediately.
create or replace function public.deactivate_member(p_business uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_owner(p_business) then
    raise exception 'Only the owner can remove team members' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'You cannot remove yourself' using errcode = '22023';
  end if;
  update public.memberships set active = false where business_id = p_business and user_id = p_user;
end $$;

-- Fictional, generic catalogue for trying the workflow before entering real products.
create or replace function public.load_demo_catalogue(p_business uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_count int := 0; r record; v_id uuid;
begin
  if not private.is_owner(p_business) then
    raise exception 'Only the owner can load demo data' using errcode = '42501';
  end if;
  for r in select * from (values
    ('DEMO-001', 'Sparkling water 500ml', 'unit'::public.tracking_mode, 'unit', 'unit', 'P001', 18.00),
    ('DEMO-002', 'Granola bar',           'unit',                        'unit', 'unit', 'P002', 25.00),
    ('DEMO-003', 'Loose tea (by weight)', 'weight',                      'g',    'kg',   'P003', 0.45),
    ('DEMO-004', 'Mixed nuts (by weight)','weight',                      'g',    'kg',   'P004', 0.32)
  ) as t(sku, name, mode, base, display, code, price)
  loop
    insert into public.products (business_id, sku, name, tracking_mode, base_unit, display_unit, pos_code)
    values (p_business, r.sku, r.name, r.mode, r.base, r.display, r.code)
    on conflict (business_id, sku) do nothing
    returning id into v_id;
    if v_id is not null then
      insert into public.product_prices (product_id, unit_price, valid_from, created_by)
      values (v_id, r.price, now() - interval '1 day', auth.uid());
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

revoke execute on function public.create_business(text, text, numeric) from public, anon;
revoke execute on function public.add_member(uuid, text, public.member_role, uuid[]) from public, anon;
revoke execute on function public.deactivate_member(uuid, uuid) from public, anon;
revoke execute on function public.load_demo_catalogue(uuid) from public, anon;
grant execute on function public.create_business(text, text, numeric) to authenticated;
grant execute on function public.add_member(uuid, text, public.member_role, uuid[]) to authenticated;
grant execute on function public.deactivate_member(uuid, uuid) to authenticated;
grant execute on function public.load_demo_catalogue(uuid) to authenticated;

-- Owners may edit their business settings, but billing status is set by the
-- billing system (service role), never from the app.
create or replace function private.protect_business_status()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and new.status is distinct from old.status then
    raise exception 'Business status is managed by billing' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger businesses_protect_status before update on businesses
  for each row execute function private.protect_business_status();
