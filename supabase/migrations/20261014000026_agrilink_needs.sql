-- Confirmed buyer needs, shown on the public AgriLink page. Only a platform
-- admin adds or closes them; the public sees display fields only, and the
-- buyer's name only when the buyer agreed (show_name).
create table public.agri_needs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  province text not null check (province in ('Eastern Cape','Free State','Gauteng','KwaZulu-Natal','Limpopo','Mpumalanga','North West','Northern Cape','Western Cape')),
  town text not null check (length(btrim(town)) between 2 and 60),
  buyer_kind text not null check (length(btrim(buyer_kind)) between 2 and 40),
  buyer_name text check (buyer_name is null or length(buyer_name) <= 80),
  show_name boolean not null default false,
  crop text not null check (length(btrim(crop)) between 2 and 40),
  qty numeric(12,2) not null check (qty > 0 and qty < 10000000),
  unit text not null check (unit in ('kg','crates','bags','boxes','bunches','heads','dozen','tonnes','litres','units')),
  frequency text not null check (frequency in ('weekly','fortnightly','monthly','once')),
  price_note text check (price_note is null or length(price_note) <= 60),
  active boolean not null default true
);
alter table public.agri_needs enable row level security;
revoke all on public.agri_needs from anon, authenticated;

create or replace function public.agri_needs_public(p_province text)
returns table (id uuid, created_at timestamptz, province text, town text, buyer_kind text, buyer text, crop text, qty numeric, unit text, frequency text, price_note text)
language sql stable security definer set search_path = ''
as $$
  select n.id, n.created_at, n.province, n.town, n.buyer_kind, case when n.show_name then n.buyer_name end, n.crop, n.qty, n.unit, n.frequency, n.price_note
  from public.agri_needs n
  where n.active and (p_province is null or n.province = p_province)
  order by n.created_at desc limit 100
$$;
grant execute on function public.agri_needs_public(text) to anon, authenticated;

create or replace function public.admin_agri_needs()
returns setof public.agri_needs language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Not found' using errcode = 'P0002'; end if;
  return query select * from public.agri_needs order by active desc, created_at desc limit 300;
end $$;
revoke execute on function public.admin_agri_needs() from public, anon;
grant execute on function public.admin_agri_needs() to authenticated;

create or replace function public.admin_add_agri_need(p_province text, p_town text, p_kind text, p_name text, p_show_name boolean, p_crop text, p_qty numeric, p_unit text, p_frequency text, p_price_note text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v uuid;
begin
  if not private.is_platform_admin() then raise exception 'Not found' using errcode = 'P0002'; end if;
  insert into public.agri_needs (province, town, buyer_kind, buyer_name, show_name, crop, qty, unit, frequency, price_note)
  values (p_province, btrim(p_town), btrim(p_kind), nullif(btrim(coalesce(p_name,'')),''), coalesce(p_show_name,false) and nullif(btrim(coalesce(p_name,'')),'') is not null, btrim(p_crop), p_qty, p_unit, p_frequency, nullif(btrim(coalesce(p_price_note,'')),''))
  returning id into v;
  return v;
end $$;
revoke execute on function public.admin_add_agri_need(text,text,text,text,boolean,text,numeric,text,text,text) from public, anon;
grant execute on function public.admin_add_agri_need(text,text,text,text,boolean,text,numeric,text,text,text) to authenticated;

create or replace function public.admin_set_agri_need_active(p_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Not found' using errcode = 'P0002'; end if;
  update public.agri_needs set active = p_active where id = p_id;
end $$;
revoke execute on function public.admin_set_agri_need_active(uuid, boolean) from public, anon;
grant execute on function public.admin_set_agri_need_active(uuid, boolean) to authenticated;
