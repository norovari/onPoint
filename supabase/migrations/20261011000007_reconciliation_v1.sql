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
