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
