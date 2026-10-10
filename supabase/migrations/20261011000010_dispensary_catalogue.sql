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
