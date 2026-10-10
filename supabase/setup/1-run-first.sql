-- OnPoint database setup, PART 1 of 2. Paste all of this into Supabase SQL Editor and click Run.
-- Then run PART 2 in a new query. (Two parts because new list values must be saved before they are used.)

-- ===== 20261010000001_schema.sql =====
-- OnPoint — core schema
-- Multi-tenant from day one: every operational row traces back to a business.
-- Money uses numeric(14,2); quantities use numeric(14,3) in each product's base unit
-- (e.g. grams for weighed items, units for packaged items). Never use float.

-- gen_random_uuid() is built into PostgreSQL 13+, no extension needed.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type member_role       as enum ('staff', 'manager', 'owner');
create type tracking_mode     as enum ('unit', 'weight');
create type shift_status      as enum ('opening', 'active', 'closing_submitted', 'correction_requested', 'approved');
create type count_type        as enum ('opening', 'closing');
create type movement_type     as enum (
  -- Customer refunds/returns come through the POS as negative sale lines,
  -- so there is deliberately no CUSTOMER_RETURN movement (it would double-count).
  'RECEIPT', 'TRANSFER_IN', 'TRANSFER_OUT',
  'WASTAGE', 'DAMAGE', 'INTERNAL_USE', 'ADJUSTMENT'
);
create type payment_method    as enum ('cash', 'card', 'eft', 'other');
create type cash_event_type   as enum ('PAID_IN', 'PAID_OUT', 'REMOVED', 'BANKED');
create type import_status     as enum ('validated', 'rejected', 'superseded');
create type recon_status      as enum ('matched', 'variance', 'pending', 'missing_evidence');
create type approval_decision as enum ('approved', 'returned');
create type exception_type    as enum ('stock_variance', 'cash_variance', 'settlement_variance', 'sales_value_variance', 'opening_float_variance', 'missing_evidence');
create type exception_status  as enum ('open', 'explained', 'resolved', 'superseded');
create type subscription_plan as enum ('starter', 'business', 'multi_site');
create type subscription_state as enum ('trialing', 'active', 'past_due', 'cancelled');

-- ---------------------------------------------------------------------------
-- Tenancy and people
-- ---------------------------------------------------------------------------
create table businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  timezone    text not null default 'Africa/Johannesburg',
  currency    char(3) not null default 'ZAR',
  status      text not null default 'active' check (status in ('active', 'suspended')),
  -- Variance thresholds above which an exception is raised (business-configurable)
  cash_tolerance        numeric(14,2) not null default 0.00 check (cash_tolerance >= 0),
  stock_tolerance_pct   numeric(6,3)  not null default 0.000 check (stock_tolerance_pct >= 0),
  allow_self_approval   boolean not null default false,
  created_at  timestamptz not null default now()
);

create table locations (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references businesses(id) on delete restrict,
  name                  text not null,
  standard_float        numeric(14,2) not null default 0.00 check (standard_float >= 0),
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  unique (business_id, name)
);
create index on locations (business_id);

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table memberships (
  business_id uuid not null references businesses(id) on delete restrict,
  user_id     uuid not null references profiles(id) on delete cascade,
  role        member_role not null,
  -- null = all locations in the business (owners); otherwise restricted list
  location_ids uuid[],
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index on memberships (user_id);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
create table products (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete restrict,
  sku            text not null,
  name           text not null,
  tracking_mode  tracking_mode not null,
  base_unit      text not null check (base_unit in ('unit', 'g', 'ml')),
  display_unit   text not null default 'unit',
  pos_code       text,  -- product code as it appears in the POS export
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (business_id, sku),
  unique (business_id, pos_code),
  check ((tracking_mode = 'unit' and base_unit = 'unit') or (tracking_mode = 'weight' and base_unit in ('g', 'ml')))
);
create index on products (business_id);

-- Price per base unit, with effective dating so history never gets re-priced.
create table product_prices (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete restrict,
  unit_price  numeric(14,4) not null check (unit_price >= 0),
  valid_from  timestamptz not null,
  valid_to    timestamptz,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from)
);
create index on product_prices (product_id, valid_from);

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------
create table shifts (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete restrict,
  location_id       uuid not null references locations(id) on delete restrict,
  status            shift_status not null default 'opening',
  opened_by         uuid not null references profiles(id),
  opened_at         timestamptz not null default now(),
  opening_float     numeric(14,2) check (opening_float >= 0),
  closed_by         uuid references profiles(id),
  closing_submitted_at timestamptz,
  counted_closing_cash numeric(14,2) check (counted_closing_cash >= 0),
  previous_shift_id uuid references shifts(id),
  created_at        timestamptz not null default now()
);
create index on shifts (business_id, location_id, opened_at desc);
-- Only one non-approved shift per location at a time
create unique index one_open_shift_per_location on shifts (location_id)
  where status in ('opening', 'active', 'closing_submitted', 'correction_requested');

-- Physical counts. Counts are append-only: a recount adds a new version.
create table stock_counts (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id),
  shift_id      uuid not null references shifts(id) on delete restrict,
  product_id    uuid not null references products(id) on delete restrict,
  count_type    count_type not null,
  quantity      numeric(14,3) not null check (quantity >= 0),
  version       int not null default 1 check (version >= 1),
  reason        text,  -- required for version > 1
  submitted_by  uuid not null references profiles(id),
  submitted_at  timestamptz not null default now(),
  unique (shift_id, product_id, count_type, version),
  check (version = 1 or (reason is not null and length(trim(reason)) > 0))
);
create index on stock_counts (shift_id);

-- Every non-sale stock movement. Sales come from POS imports, not here.
create table stock_movements (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id),
  shift_id        uuid not null references shifts(id) on delete restrict,
  product_id      uuid not null references products(id) on delete restrict,
  movement_type   movement_type not null,
  -- Always positive; direction is defined by movement_type.
  -- ADJUSTMENT uses signed quantity (it corrects in either direction).
  quantity        numeric(14,3) not null,
  reason          text not null check (length(trim(reason)) > 0),
  reference       text,  -- delivery note, transfer slip, etc.
  corrects_movement_id uuid references stock_movements(id),
  requires_approval boolean not null default false,
  approved_by     uuid references profiles(id),
  approved_at     timestamptz,
  created_by      uuid not null references profiles(id),
  created_at      timestamptz not null default now(),
  check (movement_type = 'ADJUSTMENT' or quantity > 0),
  check (movement_type <> 'ADJUSTMENT' or quantity <> 0)
);
create index on stock_movements (shift_id);

-- Cash events in the till other than sales/refunds (those come from POS)
create table cash_events (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  shift_id    uuid not null references shifts(id) on delete restrict,
  event_type  cash_event_type not null,
  amount      numeric(14,2) not null check (amount > 0),
  reason      text not null check (length(trim(reason)) > 0),
  reference   text,
  created_by  uuid not null references profiles(id),
  created_at  timestamptz not null default now()
);
create index on cash_events (shift_id);

-- ---------------------------------------------------------------------------
-- POS data
-- ---------------------------------------------------------------------------
create table pos_imports (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references businesses(id),
  location_id        uuid not null references locations(id),
  shift_id           uuid not null references shifts(id) on delete restrict,
  source             text not null default 'csv',
  file_name          text,
  file_sha256        text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path       text,  -- private storage bucket path of original file
  status             import_status not null default 'validated',
  row_count          int not null default 0,
  -- POS-reported totals for the period (tax-inclusive, after discounts)
  pos_total_sales    numeric(14,2) not null default 0,
  pos_total_refunds  numeric(14,2) not null default 0,
  imported_by        uuid not null references profiles(id),
  imported_at        timestamptz not null default now(),
  unique (shift_id, file_sha256)
);
create index on pos_imports (shift_id);

create table pos_sales_lines (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id),
  import_id         uuid not null references pos_imports(id) on delete restrict,
  shift_id          uuid not null references shifts(id) on delete restrict,
  external_ref      text not null,  -- transaction id + line number from the POS
  transaction_at    timestamptz not null,
  product_id        uuid references products(id),   -- null if unmapped (raises an exception)
  pos_code          text not null,
  quantity          numeric(14,3) not null,  -- negative for refund lines
  gross_amount      numeric(14,2) not null,  -- tax-inclusive before discount
  discount_amount   numeric(14,2) not null default 0 check (discount_amount >= 0),
  tax_amount        numeric(14,2) not null default 0,
  payment_method    payment_method not null,
  is_refund         boolean not null default false,
  is_void           boolean not null default false,
  -- The same POS line can never be counted twice in one business
  unique (business_id, external_ref)
);
create index on pos_sales_lines (shift_id);
create index on pos_sales_lines (import_id);

-- ---------------------------------------------------------------------------
-- Settlements and reconciliation results
-- ---------------------------------------------------------------------------
create table settlement_records (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references businesses(id),
  location_id        uuid not null references locations(id),
  shift_id           uuid references shifts(id),  -- may be linked after the fact
  payment_method     payment_method not null check (payment_method in ('card', 'eft', 'other')),
  provider           text not null,
  provider_reference text not null,
  settlement_date    date not null,
  gross_amount       numeric(14,2) not null,
  fees               numeric(14,2) not null default 0 check (fees >= 0),
  refunds            numeric(14,2) not null default 0 check (refunds >= 0),
  adjustments        numeric(14,2) not null default 0,
  net_amount         numeric(14,2) not null,
  created_by         uuid not null references profiles(id),
  created_at         timestamptz not null default now(),
  unique (business_id, provider, provider_reference),
  check (net_amount = gross_amount - fees - refunds + adjustments)
);
create index on settlement_records (shift_id);

-- Snapshot of the computed reconciliation when a shift is submitted
create table payment_reconciliations (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id),
  shift_id        uuid not null references shifts(id) on delete restrict,
  payment_method  payment_method not null,
  expected_amount numeric(14,2) not null,
  actual_amount   numeric(14,2),
  difference      numeric(14,2),
  status          recon_status not null,
  calculation     jsonb not null default '{}'::jsonb,  -- every input, for traceability
  computed_at     timestamptz not null default now(),
  version         int not null default 1,
  unique (shift_id, payment_method, version)
);

create table handover_checklists (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id),
  shift_id       uuid not null references shifts(id) on delete restrict,
  submitted_by   uuid not null references profiles(id),
  checklist_data jsonb not null default '{}'::jsonb,
  notes          text,
  submitted_at   timestamptz not null default now()
);
create index on handover_checklists (shift_id);

create table approvals (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  shift_id    uuid not null references shifts(id) on delete restrict,
  reviewer_id uuid not null references profiles(id),
  decision    approval_decision not null,
  notes       text,
  decided_at  timestamptz not null default now(),
  check (decision = 'approved' or (notes is not null and length(trim(notes)) > 0))
);
create index on approvals (shift_id);

create table exceptions (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id),
  shift_id        uuid not null references shifts(id) on delete restrict,
  exception_type  exception_type not null,
  stage           text not null default 'closing' check (stage in ('opening', 'closing')),
  product_id      uuid references products(id),
  payment_method  payment_method,
  expected        numeric(14,3),
  actual          numeric(14,3),
  difference      numeric(14,3),
  severity        text not null default 'review' check (severity in ('info', 'review', 'high')),
  status          exception_status not null default 'open',
  assigned_to     uuid references profiles(id),
  explanation     text,
  resolved_by     uuid references profiles(id),
  resolved_at     timestamptz,
  carried_from_id uuid references exceptions(id),
  created_at      timestamptz not null default now()
);
create index on exceptions (business_id, status);
create index on exceptions (shift_id);

-- ---------------------------------------------------------------------------
-- Audit and billing
-- ---------------------------------------------------------------------------
create table audit_events (
  id          bigint generated always as identity primary key,
  business_id uuid not null references businesses(id),
  actor_id    uuid,
  action      text not null,
  entity_type text not null,
  entity_id   text not null,
  old_values  jsonb,
  new_values  jsonb,
  created_at  timestamptz not null default now()
);
create index on audit_events (business_id, created_at desc);
create index on audit_events (entity_type, entity_id);

create table subscriptions (
  business_id        uuid primary key references businesses(id) on delete restrict,
  plan               subscription_plan not null default 'starter',
  status             subscription_state not null default 'trialing',
  current_period_end timestamptz,
  billing_provider   text,
  billing_customer_ref text,
  billing_subscription_ref text,
  updated_at         timestamptz not null default now()
);

-- Paid report add-ons: one row per purchased report
create table report_purchases (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id),
  report_type  text not null,
  params       jsonb not null default '{}'::jsonb,
  amount       numeric(14,2) not null check (amount >= 0),
  status       text not null default 'pending' check (status in ('pending', 'paid', 'generated', 'refunded')),
  requested_by uuid not null references profiles(id),
  created_at   timestamptz not null default now()
);

-- ===== 20261010000002_security.sql =====
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

-- ===== 20261010000003_workflow.sql =====
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

-- ===== 20261010000004_onboarding.sql =====
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

-- ===== 20261011000005_enum_values.sql =====
-- OnPoint v1 — new enum values.
-- Kept in its own migration: Postgres won't let a new enum value be used in the
-- same transaction that adds it.

alter type exception_type add value if not exists 'special_mismatch';
alter type exception_type add value if not exists 'went_into_minus';
alter type exception_type add value if not exists 'low_stock';

alter type subscription_plan add value if not exists 'free';
