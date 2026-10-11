-- Any till file, and shops with no till file at all.
--
-- 1. businesses.pos_layout remembers how this shop's till export is laid out
--    (which column is which) and which till items are which products, so the
--    owner only confirms it once (lib/pos/smart.ts reads the file).
-- 2. businesses.sales_source = 'counts' for shops that don't upload a till
--    file: at close, what was sold is worked out from the stock counts, priced
--    at the shop's prices, and compared with the cash and card actually taken.

alter table public.businesses add column if not exists pos_layout jsonb not null default '{}'::jsonb;
alter table public.businesses add column if not exists sales_source text not null default 'till';
alter table public.businesses drop constraint if exists businesses_sales_source_check;
alter table public.businesses add constraint businesses_sales_source_check check (sales_source in ('till', 'counts'));

create or replace function public.set_pos_layout(p_business uuid, p_layout jsonb)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_manager(p_business) then
    raise exception 'Only managers and owners can change how till files are read' using errcode = '42501';
  end if;
  if jsonb_typeof(p_layout) <> 'object' or length(p_layout::text) > 200000 then
    raise exception 'Layout not valid' using errcode = '22023';
  end if;
  update public.businesses set pos_layout = p_layout where id = p_business;
end $$;

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
  update public.businesses set sales_source = p_source where id = p_business;
end $$;

-- Called from submit_closing (inside its workflow) for 'counts' shops.
-- Sold = opening + received - moved out - closing count, less anything already
-- recorded as specials. Each product's sale is priced at the shop's price.
-- The money expected is then split: card = the card machine total (up to the
-- value), cash = the rest, so the cash check compares money with stock.
create or replace function private.counts_sales(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_shift  public.shifts%rowtype;
  v_import uuid;
  v_tag    text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  v_total  numeric;
  v_rows   int;
  v_card   numeric;
begin
  select * into v_shift from public.shifts where id = p_shift;

  -- A resubmitted close replaces the earlier calculation
  update public.pos_sales_lines set is_void = true
   where shift_id = p_shift and not is_void
     and import_id in (select id from public.pos_imports where shift_id = p_shift and source = 'counts');
  update public.pos_imports set status = 'superseded'
   where shift_id = p_shift and source = 'counts' and status = 'validated';

  insert into public.pos_imports (business_id, location_id, shift_id, source, file_name, file_sha256, row_count, pos_total_sales, imported_by)
  values (v_shift.business_id, v_shift.location_id, p_shift, 'counts', 'Worked out from stock counts',
          encode(sha256(convert_to(p_shift::text || v_tag, 'UTF8')), 'hex'), 0, 0, auth.uid())
  returning id into v_import;

  with latest as (
    select distinct on (product_id, count_type) product_id, count_type, quantity
    from public.stock_counts where shift_id = p_shift
    order by product_id, count_type, version desc
  ),
  mv as (
    select product_id,
      sum(quantity) filter (where movement_type in ('RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT')) as added,
      sum(quantity) filter (where movement_type in ('TRANSFER_OUT', 'WASTAGE', 'DAMAGE', 'INTERNAL_USE')) as removed
    from public.stock_movements where shift_id = p_shift group by product_id
  ),
  sp as (
    select product_id, sum(quantity) as qty from public.pos_sales_lines
    where shift_id = p_shift and not is_void and product_id is not null group by product_id
  ),
  used as (
    select p.id, coalesce(p.pos_code, p.sku) as code,
      o.quantity + coalesce(mv.added, 0) - coalesce(mv.removed, 0) - c.quantity - coalesce(sp.qty, 0) as qty
    from public.products p
    join latest o on o.product_id = p.id and o.count_type = 'opening'
    join latest c on c.product_id = p.id and c.count_type = 'closing'
    left join mv on mv.product_id = p.id
    left join sp on sp.product_id = p.id
    where p.business_id = v_shift.business_id
  )
  insert into public.pos_sales_lines (business_id, import_id, shift_id, external_ref, transaction_at, product_id, pos_code,
    quantity, gross_amount, discount_amount, tax_amount, payment_method)
  select v_shift.business_id, v_import, p_shift, 'counts-' || p_shift || '-' || u.id || '-' || v_tag, now(), u.id, u.code,
    u.qty, round(u.qty * private.price_at(u.id, now()), 2), 0, 0, 'other'
  from used u
  where u.qty > 0 and private.price_at(u.id, now()) is not null;
  get diagnostics v_rows = row_count;

  select coalesce(sum(gross_amount - discount_amount), 0) into v_total
  from public.pos_sales_lines where shift_id = p_shift and not is_void and not is_refund;

  update public.pos_imports set row_count = v_rows,
    pos_total_sales = (select coalesce(sum(gross_amount), 0) from public.pos_sales_lines where import_id = v_import)
   where id = v_import;

  v_card := least(coalesce(v_shift.card_machine_total, 0), v_total);
  update public.shifts set till_card_total = v_card, till_cash_total = v_total - v_card where id = p_shift;
end $$;

revoke execute on function private.counts_sales(uuid) from public, anon, authenticated;
revoke execute on function public.set_pos_layout(uuid, jsonb) from public, anon;
revoke execute on function public.set_sales_source(uuid, text) from public, anon;
grant execute on function public.set_pos_layout(uuid, jsonb) to authenticated;
grant execute on function public.set_sales_source(uuid, text) to authenticated;

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

  -- Shops without a till file: what was sold is worked out from the counts
  if (select sales_source from public.businesses where id = v_shift.business_id) = 'counts' then
    perform private.counts_sales(p_shift);
  end if;

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
    insert into public.exceptions (business_id, shift_id, exception_type, payment_method, expected, actual, difference, severity, explanation)
    values (v_shift.business_id, p_shift, 'cash_variance', 'cash',
            (v_recon #>> '{cash,expected}')::numeric, (v_recon #>> '{cash,counted}')::numeric,
            (v_recon #>> '{cash,variance}')::numeric, 'high',
            case when (select sales_source from public.businesses where id = v_shift.business_id) = 'counts'
                 then 'Money taken (cash and card) compared with the value of the stock that left the shelf' end);
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
