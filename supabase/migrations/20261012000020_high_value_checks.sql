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
