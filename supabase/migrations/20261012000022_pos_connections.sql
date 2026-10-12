-- POS connections: the access key a shop owner pastes in so OnPoint can read
-- sales and products from their POS (Loyverse first). Readable and writable
-- only by the server (service role): there are no policies for app users, and
-- the key is never sent to a browser.

create table if not exists public.pos_connections (
  business_id  uuid primary key references public.businesses(id),
  provider     text not null default 'loyverse' check (provider in ('loyverse')),
  token        text,
  store_id     text,
  store_name   text,
  connected_by uuid references public.profiles(id),
  connected_at timestamptz not null default now()
);
alter table public.pos_connections enable row level security;

-- What the app may show: whether a POS is connected (never the key)
create or replace function public.pos_connection(p_business uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select case when private.is_member(p_business) then (
    select jsonb_build_object('provider', c.provider, 'store_name', c.store_name, 'store_id', c.store_id, 'connected_at', c.connected_at)
    from public.pos_connections c where c.business_id = p_business and c.token is not null)
  end
$$;
revoke execute on function public.pos_connection(uuid) from public, anon;
grant execute on function public.pos_connection(uuid) to authenticated;
