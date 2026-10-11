-- End-of-shift statements: each person on shift answers three questions,
-- adds photos, and confirms with their own password. The owner sees every
-- statement on the shift and in the nightly email.
--
-- Rows are written only by the server after it has checked the person's
-- password (service role), so there is no insert policy for app users, and
-- no update policy: a statement can't be changed once given.

alter table public.businesses add column if not exists require_statement boolean not null default true;

create table if not exists public.shift_statements (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id),
  shift_id           uuid not null references public.shifts(id),
  user_id            uuid not null references public.profiles(id),
  unrung             boolean not null,
  unrung_detail      text check (length(unrung_detail) <= 1000),
  stock_event        boolean not null,
  stock_event_detail text check (length(stock_event_detail) <= 1000),
  notes              text check (length(notes) <= 1000),
  photos             text[] not null default '{}' check (cardinality(photos) <= 6),
  confirmed_with     text not null default 'password' check (confirmed_with = 'password'),
  created_at         timestamptz not null default now(),
  unique (shift_id, user_id),
  check (not unrung or length(coalesce(unrung_detail, '')) > 0),
  check (not stock_event or length(coalesce(stock_event_detail, '')) > 0)
);
alter table public.shift_statements enable row level security;

-- You see your own statements; managers and owners see everyone's
create policy statements_select on public.shift_statements for select to authenticated
  using (
    private.can_access_shift(shift_id)
    and (user_id = auth.uid() or private.is_manager(business_id))
  );

create or replace function public.set_require_statement(p_business uuid, p_on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_owner(p_business) then
    raise exception 'Only the owner can change this' using errcode = '42501';
  end if;
  update public.businesses set require_statement = coalesce(p_on, true) where id = p_business;
end $$;

revoke execute on function public.set_require_statement(uuid, boolean) from public, anon;
grant execute on function public.set_require_statement(uuid, boolean) to authenticated;
