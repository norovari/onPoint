-- AgriLink: farmers list what they have for sale from a public page (no login).
-- Anyone may add a listing; nobody can read listings except a platform admin,
-- through admin_agri_listings(). One row per crop.
create table public.agri_listings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  batch uuid not null,
  farmer text not null check (length(btrim(farmer)) between 2 and 80),
  farm text check (farm is null or length(farm) <= 80),
  phone text not null check (phone ~ '^[0-9+ ()-]{9,20}$'),
  province text not null check (province in ('Eastern Cape','Free State','Gauteng','KwaZulu-Natal','Limpopo','Mpumalanga','North West','Northern Cape','Western Cape')),
  town text check (town is null or length(town) <= 60),
  crop text not null check (length(btrim(crop)) between 2 and 40),
  qty numeric(12,2) not null check (qty > 0 and qty < 10000000),
  unit text not null check (unit in ('kg','crates','bags','boxes','bunches','heads','dozen','tonnes','litres','units')),
  price numeric(12,2) check (price is null or (price >= 0 and price < 1000000)),
  available_from date,
  delivery text not null check (delivery in ('deliver','collect')),
  notes text check (notes is null or length(notes) <= 300),
  consent boolean not null check (consent),
  status text not null default 'new' check (status in ('new','loaded','test'))
);
create index agri_listings_created on public.agri_listings (created_at desc);

alter table public.agri_listings enable row level security;
revoke all on public.agri_listings from anon, authenticated;
grant insert on public.agri_listings to anon, authenticated;
create policy agri_listings_public_insert on public.agri_listings
  for insert to anon, authenticated
  with check (status = 'new' and consent and created_at > now() - interval '5 minutes');

create or replace function public.admin_agri_listings()
returns setof public.agri_listings language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Not found' using errcode = 'P0002'; end if;
  return query select * from public.agri_listings where status <> 'test' order by created_at desc limit 500;
end $$;
revoke execute on function public.admin_agri_listings() from public, anon;
grant execute on function public.admin_agri_listings() to authenticated;

-- Which plan the farmer is interested in (optional).
alter table public.agri_listings add column plan text check (plan is null or plan in ('starter','grower','coop','unsure'));
