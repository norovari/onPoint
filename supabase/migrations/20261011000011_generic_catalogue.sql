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

