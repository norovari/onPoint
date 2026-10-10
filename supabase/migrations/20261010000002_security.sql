-- OnPoint — access control, immutability and audit
--
-- Principles
--  * Row Level Security on every table. The browser only ever holds the
--    publishable (anon) key, so these policies are the real security boundary.
--  * Records that act as evidence (counts, movements, cash events, POS lines,
--    approvals, audit events) are append-only. Corrections add new rows.
--  * Workflow state changes (open, activate, submit, approve) go through
--    SECURITY DEFINER functions in 20261010000003, never direct UPDATEs.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so they can read memberships under RLS)
-- Every boolean helper must return true/false, never NULL: `if not NULL` does
-- not fire in plpgsql, which would silently skip a permission check.
-- ---------------------------------------------------------------------------
create or replace function private.member_role(p_business uuid)
returns member_role
language sql stable security definer set search_path = ''
as $$
  select m.role
  from public.memberships m
  join public.profiles p on p.id = m.user_id
  where m.business_id = p_business
    and m.user_id = auth.uid()
    and m.active and p.active
$$;

create or replace function private.is_member(p_business uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select private.member_role(p_business) is not null $$;

create or replace function private.is_manager(p_business uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.member_role(p_business) in ('manager', 'owner'), false) $$;

create or replace function private.is_owner(p_business uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.member_role(p_business) = 'owner', false) $$;

create or replace function private.can_access_location(p_business uuid, p_location uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.profiles p on p.id = m.user_id
    join public.locations l on l.id = p_location and l.business_id = m.business_id
    where m.business_id = p_business
      and m.user_id = auth.uid()
      and m.active and p.active
      and (m.role = 'owner' or m.location_ids is null or p_location = any (m.location_ids))
  )
$$;

create or replace function private.can_access_shift(p_shift uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.shifts s
    where s.id = p_shift and private.can_access_location(s.business_id, s.location_id)
  )
$$;

-- Staff may see money figures only for shifts they opened or closed.
create or replace function private.can_see_shift_money(p_shift uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.shifts s
    where s.id = p_shift
      and private.can_access_location(s.business_id, s.location_id)
      and (private.is_manager(s.business_id) or auth.uid() in (s.opened_by, s.closed_by))
  )
$$;

create or replace function private.shift_accepts_entries(p_shift uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.shifts s
    where s.id = p_shift and s.status in ('opening', 'active', 'correction_requested')
  )
$$;

grant execute on all functions in schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'businesses','locations','profiles','memberships','products','product_prices',
    'shifts','stock_counts','stock_movements','cash_events','pos_imports','pos_sales_lines',
    'settlement_records','payment_reconciliations','handover_checklists','approvals',
    'exceptions','audit_events','subscriptions','report_purchases'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- businesses
create policy businesses_select on businesses for select to authenticated
  using (private.is_member(id));
create policy businesses_update on businesses for update to authenticated
  using (private.is_owner(id)) with check (private.is_owner(id));

-- locations
create policy locations_select on locations for select to authenticated
  using (private.can_access_location(business_id, id));
create policy locations_write on locations for all to authenticated
  using (private.is_owner(business_id)) with check (private.is_owner(business_id));

-- profiles: yourself, plus colleagues' names in businesses you share
create policy profiles_select on profiles for select to authenticated
  using (
    id = auth.uid() or exists (
      select 1 from memberships mine
      join memberships theirs on theirs.business_id = mine.business_id
      where mine.user_id = auth.uid() and mine.active and theirs.user_id = profiles.id
    )
  );
create policy profiles_update_self on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- memberships: staff see their own row; managers/owners see the business
create policy memberships_select on memberships for select to authenticated
  using (user_id = auth.uid() or private.is_manager(business_id));
create policy memberships_owner_write on memberships for all to authenticated
  using (private.is_owner(business_id)) with check (private.is_owner(business_id));

-- catalogue: everyone in the business reads; owners change
create policy products_select on products for select to authenticated
  using (private.is_member(business_id));
create policy products_write on products for all to authenticated
  using (private.is_owner(business_id)) with check (private.is_owner(business_id));

create policy prices_select on product_prices for select to authenticated
  using (exists (select 1 from products p where p.id = product_id and private.is_member(p.business_id)));
create policy prices_insert on product_prices for insert to authenticated
  with check (exists (select 1 from products p where p.id = product_id and private.is_owner(p.business_id)));

-- shifts: read at your locations; all writes via functions
create policy shifts_select on shifts for select to authenticated
  using (private.can_access_location(business_id, location_id));

-- stock counts: insert own counts while the shift accepts entries
create policy counts_select on stock_counts for select to authenticated
  using (private.can_access_shift(shift_id));
create policy counts_insert on stock_counts for insert to authenticated
  with check (
    submitted_by = auth.uid()
    and private.can_access_shift(shift_id)
    and private.shift_accepts_entries(shift_id)
    and business_id = (select s.business_id from shifts s where s.id = shift_id)
  );

-- stock movements: staff may record receipts and transfers in; managers anything
create policy movements_select on stock_movements for select to authenticated
  using (private.can_access_shift(shift_id));
create policy movements_insert on stock_movements for insert to authenticated
  with check (
    created_by = auth.uid()
    and private.can_access_shift(shift_id)
    and private.shift_accepts_entries(shift_id)
    and business_id = (select s.business_id from shifts s where s.id = shift_id)
  );

-- cash events: managers only (removing/banking cash is a controlled action)
create policy cash_events_select on cash_events for select to authenticated
  using (private.can_see_shift_money(shift_id));
create policy cash_events_insert on cash_events for insert to authenticated
  with check (
    created_by = auth.uid()
    and private.is_manager(business_id)
    and private.can_access_shift(shift_id)
    and private.shift_accepts_entries(shift_id)
    and business_id = (select s.business_id from shifts s where s.id = shift_id)
  );

-- POS data: read with money access; writes only via import_pos_batch()
create policy pos_imports_select on pos_imports for select to authenticated
  using (private.can_see_shift_money(shift_id));
create policy pos_lines_select on pos_sales_lines for select to authenticated
  using (private.can_see_shift_money(shift_id));

-- settlements: managers record and read
create policy settlements_select on settlement_records for select to authenticated
  using (private.is_manager(business_id) and private.can_access_location(business_id, location_id));
create policy settlements_insert on settlement_records for insert to authenticated
  with check (
    created_by = auth.uid()
    and private.is_manager(business_id)
    and private.can_access_location(business_id, location_id)
    and (shift_id is null or private.can_access_shift(shift_id))
  );

create policy recon_select on payment_reconciliations for select to authenticated
  using (private.can_see_shift_money(shift_id));

create policy handover_select on handover_checklists for select to authenticated
  using (private.can_access_shift(shift_id));

create policy approvals_select on approvals for select to authenticated
  using (private.can_access_shift(shift_id));

create policy exceptions_select on exceptions for select to authenticated
  using (
    private.can_access_shift(shift_id)
    and (exception_type in ('stock_variance', 'missing_evidence') or private.can_see_shift_money(shift_id))
  );

create policy audit_select on audit_events for select to authenticated
  using (private.is_manager(business_id));

create policy subscriptions_select on subscriptions for select to authenticated
  using (private.is_owner(business_id));

create policy report_purchases_select on report_purchases for select to authenticated
  using (private.is_owner(business_id));
create policy report_purchases_insert on report_purchases for insert to authenticated
  with check (private.is_owner(business_id) and requested_by = auth.uid() and status = 'pending');

-- ---------------------------------------------------------------------------
-- Append-only evidence: block UPDATE and DELETE for everyone except the
-- narrowly scoped workflow functions (which set a transaction-local flag).
-- ---------------------------------------------------------------------------
create or replace function private.forbid_change()
returns trigger
language plpgsql
as $$
begin
  if current_setting('onpoint.workflow', true) = 'on' and tg_op = 'UPDATE' then
    return new;
  end if;
  raise exception 'Records in % are append-only. Add a correction instead of changing or deleting.', tg_table_name
    using errcode = 'P0001';
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'stock_counts','stock_movements','cash_events','pos_imports','pos_sales_lines',
    'settlement_records','payment_reconciliations','handover_checklists','approvals','audit_events'
  ] loop
    execute format(
      'create trigger %I before update or delete on public.%I for each row execute function private.forbid_change()',
      t || '_append_only', t);
  end loop;
end $$;

-- Shifts and exceptions can change state, but only through workflow functions,
-- and never be deleted.
create or replace function private.workflow_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% rows cannot be deleted', tg_table_name using errcode = 'P0001';
  end if;
  if coalesce(current_setting('onpoint.workflow', true), '') <> 'on' then
    raise exception '% can only be changed through OnPoint workflow functions', tg_table_name
      using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;

create trigger shifts_workflow_only before update or delete on shifts
  for each row execute function private.workflow_only();
create trigger exceptions_workflow_only before update or delete on exceptions
  for each row execute function private.workflow_only();

-- Movements of sensitive types need manager approval before the shift can be approved.
create or replace function private.flag_movement_approval()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- Never trust approval fields sent by the client
  new.approved_by := null;
  new.approved_at := null;
  new.requires_approval := new.movement_type in ('WASTAGE', 'DAMAGE', 'INTERNAL_USE', 'ADJUSTMENT', 'TRANSFER_OUT')
    and not private.is_manager(new.business_id);
  -- A manager recording a sensitive movement is treated as self-approved but still audited.
  if not new.requires_approval and new.movement_type in ('WASTAGE', 'DAMAGE', 'INTERNAL_USE', 'ADJUSTMENT', 'TRANSFER_OUT') then
    new.approved_by := new.created_by;
    new.approved_at := now();
  end if;
  return new;
end $$;

create trigger movements_flag_approval before insert on stock_movements
  for each row execute function private.flag_movement_approval();

-- Count versions must be sequential: version n requires n-1 to exist.
create or replace function private.check_count_version()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_max int;
begin
  -- Don't reveal anything about shifts the caller can't access; RLS rejects the row.
  if auth.uid() is not null and not private.can_access_shift(new.shift_id) then
    return new;
  end if;
  select coalesce(max(version), 0) into v_max
  from public.stock_counts
  where shift_id = new.shift_id and product_id = new.product_id and count_type = new.count_type;
  if new.version <> v_max + 1 then
    raise exception 'Count version must be % (a recount adds a new version with a reason)', v_max + 1
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger counts_check_version before insert on stock_counts
  for each row execute function private.check_count_version();

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------
create or replace function private.audit_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.audit_events (business_id, actor_id, action, entity_type, entity_id, old_values, new_values)
  values (
    (v_row ->> 'business_id')::uuid,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', ''),
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'shifts','stock_counts','stock_movements','cash_events','pos_imports',
    'settlement_records','handover_checklists','approvals','exceptions',
    'products','memberships','locations'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_row()',
      t || '_audit', t);
  end loop;
end $$;

-- product_prices has no business_id column; audit it through its product
create or replace function private.audit_price()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.audit_events (business_id, actor_id, action, entity_type, entity_id, new_values)
  select p.business_id, auth.uid(), lower(tg_op), 'product_prices', new.id::text, to_jsonb(new)
  from public.products p where p.id = new.product_id;
  return new;
end $$;
create trigger product_prices_audit after insert on product_prices
  for each row execute function private.audit_price();

-- Create a profile row automatically for every new auth user
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
