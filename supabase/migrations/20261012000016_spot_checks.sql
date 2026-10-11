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
