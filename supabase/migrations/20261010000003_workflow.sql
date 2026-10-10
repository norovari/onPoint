-- OnPoint — reconciliation engine and shift workflow
--
-- shift_reconciliation() is the single source of truth for every expected
-- figure. The TypeScript in lib/calculations mirrors it for live previews and
-- is tested against it (tests/sql-parity.test.ts).
--
-- Sign conventions for POS lines:
--   sale line   : quantity > 0, gross_amount > 0, discount_amount >= 0
--   refund line : quantity < 0, gross_amount < 0, is_refund = true
--   void line   : is_void = true — excluded from every total
--   net amount  : gross_amount - discount_amount

-- ---------------------------------------------------------------------------
-- Price lookup at a point in time
-- ---------------------------------------------------------------------------
create or replace function private.price_at(p_product uuid, p_at timestamptz)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select pp.unit_price
  from public.product_prices pp
  where pp.product_id = p_product
    and pp.valid_from <= p_at
    and (pp.valid_to is null or pp.valid_to > p_at)
  order by pp.valid_from desc
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------
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
    select product_id, sum(quantity) as net_sold
    from public.pos_sales_lines
    where shift_id = p_shift and not is_void and product_id is not null
    group by product_id
  ),
  prod_rows as (
    select
      p.id, p.sku, p.name, p.tracking_mode, p.base_unit,
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
      'net_sold', c.net_sold, 'unapproved_movements', c.unapproved,
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
    'import_count',    (select count(*) from public.pos_imports i where i.shift_id = p_shift and i.status = 'validated')
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
    select c.*, e.*,
      coalesce(v_shift.opening_float, 0) + c.cash_sales - c.cash_refunds
        + e.paid_in - e.paid_out - e.removed - e.banked as expected
    from c, e
  )
  select jsonb_build_object(
    'opening_float', coalesce(v_shift.opening_float, 0),
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
  with pos as (
    select payment_method, sum(gross_amount - discount_amount) as pos_net
    from public.pos_sales_lines
    where shift_id = p_shift and not is_void and payment_method <> 'cash'
    group by payment_method
  ),
  st as (
    select payment_method,
      sum(gross_amount) as gross, sum(refunds) as refunds, sum(fees) as fees,
      sum(adjustments) as adjustments, sum(net_amount) as net,
      jsonb_agg(provider || ':' || provider_reference order by provider_reference) as refs
    from public.settlement_records
    where shift_id = p_shift
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

  return jsonb_build_object(
    'shift_id', p_shift,
    'money_visible', true,
    'stock', v_stock,
    'sales', v_sales,
    'cash', v_cash,
    'settlements', v_settle
  );
end $$;

-- ---------------------------------------------------------------------------
-- Workflow helpers
-- ---------------------------------------------------------------------------
create or replace function private.begin_workflow()
returns void language sql as $$ select set_config('onpoint.workflow', 'on', true) $$;

create or replace function private.end_workflow()
returns void language sql as $$ select set_config('onpoint.workflow', 'off', true) $$;

-- ---------------------------------------------------------------------------
-- Open a shift
-- ---------------------------------------------------------------------------
create or replace function public.open_shift(p_location uuid, p_opening_float numeric)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_business uuid;
  v_prev     uuid;
  v_id       uuid;
begin
  select business_id into v_business from public.locations where id = p_location and active;
  if v_business is null or not private.can_access_location(v_business, p_location) then
    raise exception 'Location not found' using errcode = 'P0002';
  end if;
  if p_opening_float is null or p_opening_float < 0 then
    raise exception 'Opening float must be zero or more' using errcode = '22023';
  end if;

  select id into v_prev from public.shifts
  where location_id = p_location and status = 'approved'
  order by opened_at desc limit 1;

  insert into public.shifts (business_id, location_id, opened_by, opening_float, previous_shift_id)
  values (v_business, p_location, auth.uid(), round(p_opening_float, 2), v_prev)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'This location already has a shift in progress' using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------------------
-- Finish opening: all opening counts in, compare with the previous close
-- ---------------------------------------------------------------------------
create or replace function public.activate_shift(p_shift uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift public.shifts%rowtype;
  v_biz   public.businesses%rowtype;
  v_prev  public.shifts%rowtype;
  v_missing int;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found or not private.can_access_shift(p_shift) then
    raise exception 'Shift not found' using errcode = 'P0002';
  end if;
  if v_shift.status <> 'opening' then
    raise exception 'Shift is not in the opening stage' using errcode = 'P0001';
  end if;
  if auth.uid() <> v_shift.opened_by and not private.is_manager(v_shift.business_id) then
    raise exception 'Only the person who opened the shift or a manager can finish opening' using errcode = '42501';
  end if;
  select * into v_biz from public.businesses where id = v_shift.business_id;

  select count(*) into v_missing
  from public.products p
  where p.business_id = v_shift.business_id and p.active
    and not exists (select 1 from public.stock_counts c
                    where c.shift_id = p_shift and c.product_id = p.id and c.count_type = 'opening');
  if v_missing > 0 then
    raise exception '% product(s) still need an opening count', v_missing using errcode = 'P0001';
  end if;

  perform private.begin_workflow();

  if v_shift.previous_shift_id is not null then
    select * into v_prev from public.shifts where id = v_shift.previous_shift_id;

    -- Opening float vs cash counted at the previous close
    if v_prev.counted_closing_cash is not null
       and abs(v_shift.opening_float - v_prev.counted_closing_cash) > v_biz.cash_tolerance then
      insert into public.exceptions (business_id, shift_id, exception_type, stage, payment_method, expected, actual, difference, severity)
      values (v_shift.business_id, p_shift, 'opening_float_variance', 'opening', 'cash',
              v_prev.counted_closing_cash, v_shift.opening_float,
              v_shift.opening_float - v_prev.counted_closing_cash, 'review');
    end if;

    -- Opening counts vs previous closing counts (stock moved between shifts)
    insert into public.exceptions (business_id, shift_id, exception_type, stage, product_id, expected, actual, difference, severity)
    select v_shift.business_id, p_shift, 'stock_variance', 'opening', o.product_id,
           c.quantity, o.quantity, o.quantity - c.quantity, 'review'
    from (select distinct on (product_id) product_id, quantity from public.stock_counts
          where shift_id = p_shift and count_type = 'opening' order by product_id, version desc) o
    join (select distinct on (product_id) product_id, quantity from public.stock_counts
          where shift_id = v_prev.id and count_type = 'closing' order by product_id, version desc) c
      on c.product_id = o.product_id
    where o.quantity <> c.quantity;
  end if;

  update public.shifts set status = 'active' where id = p_shift;
  perform private.end_workflow();
end $$;

-- ---------------------------------------------------------------------------
-- POS import (atomic, idempotent per line)
-- p_lines: [{external_ref, transaction_at, pos_code, quantity, gross_amount,
--            discount_amount, tax_amount, payment_method, is_refund, is_void}]
-- ---------------------------------------------------------------------------
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
      product_id, pos_code, quantity, gross_amount, discount_amount, tax_amount, payment_method, is_refund, is_void)
    select v_shift.business_id, v_import, p_shift,
      l->>'external_ref', (l->>'transaction_at')::timestamptz,
      p.id, l->>'pos_code', (l->>'quantity')::numeric, (l->>'gross_amount')::numeric,
      coalesce((l->>'discount_amount')::numeric, 0), coalesce((l->>'tax_amount')::numeric, 0),
      (l->>'payment_method')::public.payment_method,
      coalesce((l->>'is_refund')::boolean, false), coalesce((l->>'is_void')::boolean, false)
    from jsonb_array_elements(p_lines) l
    left join public.products p on p.business_id = v_shift.business_id and p.pos_code = l->>'pos_code'
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

-- ---------------------------------------------------------------------------
-- Submit the close: snapshot reconciliation, raise exceptions, lock
-- ---------------------------------------------------------------------------
create or replace function public.submit_closing(
  p_shift uuid,
  p_counted_cash numeric,
  p_checklist jsonb,
  p_notes text
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

  perform private.end_workflow();
  return v_recon;
end $$;

-- ---------------------------------------------------------------------------
-- Manager review (separation of duties by default)
-- ---------------------------------------------------------------------------
create or replace function public.review_shift(p_shift uuid, p_decision public.approval_decision, p_notes text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift public.shifts%rowtype;
  v_biz   public.businesses%rowtype;
  v_unapproved int;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found or not private.can_access_shift(p_shift) then
    raise exception 'Shift not found' using errcode = 'P0002';
  end if;
  if not private.is_manager(v_shift.business_id) then
    raise exception 'Only managers and owners can review shifts' using errcode = '42501';
  end if;
  if v_shift.status <> 'closing_submitted' then
    raise exception 'Only submitted shifts can be reviewed' using errcode = 'P0001';
  end if;
  select * into v_biz from public.businesses where id = v_shift.business_id;
  if not v_biz.allow_self_approval and auth.uid() in (v_shift.opened_by, v_shift.closed_by) then
    raise exception 'You worked this shift, so another manager or the owner must review it' using errcode = '42501';
  end if;
  if p_decision = 'returned' and coalesce(trim(p_notes), '') = '' then
    raise exception 'Explain what needs correcting when returning a shift' using errcode = '22023';
  end if;

  if p_decision = 'approved' then
    select count(*) into v_unapproved from public.stock_movements
    where shift_id = p_shift and requires_approval and approved_by is null;
    if v_unapproved > 0 then
      raise exception '% stock movement(s) still need approval', v_unapproved using errcode = 'P0001';
    end if;
  end if;

  insert into public.approvals (business_id, shift_id, reviewer_id, decision, notes)
  values (v_shift.business_id, p_shift, auth.uid(), p_decision, p_notes);

  perform private.begin_workflow();
  update public.shifts
     set status = case when p_decision = 'approved' then 'approved'::public.shift_status
                       else 'correction_requested'::public.shift_status end
   where id = p_shift;
  perform private.end_workflow();
end $$;

-- ---------------------------------------------------------------------------
-- Approve a staff-recorded sensitive movement
-- ---------------------------------------------------------------------------
create or replace function public.approve_movement(p_movement uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_mv public.stock_movements%rowtype;
begin
  select * into v_mv from public.stock_movements where id = p_movement for update;
  if not found or not private.can_access_shift(v_mv.shift_id) then
    raise exception 'Movement not found' using errcode = 'P0002';
  end if;
  if not private.is_manager(v_mv.business_id) then
    raise exception 'Only managers and owners can approve movements' using errcode = '42501';
  end if;
  if v_mv.created_by = auth.uid() then
    raise exception 'You cannot approve a movement you recorded' using errcode = '42501';
  end if;
  if not v_mv.requires_approval or v_mv.approved_by is not null then
    raise exception 'This movement does not need approval' using errcode = 'P0001';
  end if;
  perform private.begin_workflow();
  update public.stock_movements set approved_by = auth.uid(), approved_at = now() where id = p_movement;
  perform private.end_workflow();
end $$;

-- ---------------------------------------------------------------------------
-- Explain or resolve an exception
-- ---------------------------------------------------------------------------
create or replace function public.update_exception(p_exception uuid, p_status public.exception_status, p_explanation text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_ex public.exceptions%rowtype;
begin
  select * into v_ex from public.exceptions where id = p_exception for update;
  if not found or not private.can_access_shift(v_ex.shift_id) then
    raise exception 'Exception not found' using errcode = 'P0002';
  end if;
  if p_status not in ('explained', 'resolved') then
    raise exception 'Status must be explained or resolved' using errcode = '22023';
  end if;
  if coalesce(trim(p_explanation), '') = '' then
    raise exception 'An explanation is required' using errcode = '22023';
  end if;
  if p_status = 'resolved' and not private.is_manager(v_ex.business_id) then
    raise exception 'Only managers and owners can resolve exceptions' using errcode = '42501';
  end if;
  if v_ex.exception_type not in ('stock_variance', 'missing_evidence') and not private.can_see_shift_money(v_ex.shift_id) then
    raise exception 'Exception not found' using errcode = 'P0002';
  end if;
  if v_ex.status in ('resolved', 'superseded') then
    raise exception 'This exception is already closed' using errcode = 'P0001';
  end if;

  perform private.begin_workflow();
  update public.exceptions
     set status = p_status,
         explanation = case when explanation is null then p_explanation
                            else explanation || E'\n— ' || p_explanation end,
         resolved_by = case when p_status = 'resolved' then auth.uid() end,
         resolved_at = case when p_status = 'resolved' then now() end
   where id = p_exception;
  perform private.end_workflow();
end $$;

-- Only signed-in users may call the workflow functions
revoke execute on function public.shift_reconciliation(uuid) from public, anon;
revoke execute on function public.open_shift(uuid, numeric) from public, anon;
revoke execute on function public.activate_shift(uuid) from public, anon;
revoke execute on function public.import_pos_batch(uuid, text, text, text, numeric, numeric, jsonb) from public, anon;
revoke execute on function public.submit_closing(uuid, numeric, jsonb, text) from public, anon;
revoke execute on function public.review_shift(uuid, public.approval_decision, text) from public, anon;
revoke execute on function public.approve_movement(uuid) from public, anon;
revoke execute on function public.update_exception(uuid, public.exception_status, text) from public, anon;
grant execute on function public.shift_reconciliation(uuid) to authenticated;
grant execute on function public.open_shift(uuid, numeric) to authenticated;
grant execute on function public.activate_shift(uuid) to authenticated;
grant execute on function public.import_pos_batch(uuid, text, text, text, numeric, numeric, jsonb) to authenticated;
grant execute on function public.submit_closing(uuid, numeric, jsonb, text) to authenticated;
grant execute on function public.review_shift(uuid, public.approval_decision, text) to authenticated;
grant execute on function public.approve_movement(uuid) to authenticated;
grant execute on function public.update_exception(uuid, public.exception_status, text) to authenticated;

revoke execute on all functions in schema private from public, anon;
revoke execute on function private.begin_workflow() from authenticated;
revoke execute on function private.end_workflow() from authenticated;
