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
