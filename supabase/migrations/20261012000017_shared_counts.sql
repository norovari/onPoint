-- Shared counts: when several people are on site, the closing count list is
-- shared out at random between them, so nobody knows in advance what they'll
-- count and everyone counts something different each time. Each count is
-- already recorded under the person who entered it.
--
-- Works in both modes: in spot mode the picked list is shared; in full mode
-- every product goes on the list and is shared.

alter table public.shift_count_list add column if not exists assigned_to uuid references public.profiles(id);

create table if not exists public.shift_counters (
  shift_id uuid not null references public.shifts(id),
  user_id  uuid not null references public.profiles(id),
  added_by uuid not null references public.profiles(id),
  added_at timestamptz not null default now(),
  active   boolean not null default true,
  primary key (shift_id, user_id)
);
alter table public.shift_counters enable row level security;
create policy shift_counters_select on public.shift_counters for select to authenticated
  using (private.can_access_shift(shift_id));

-- Share the uncounted part of the list at random between the counters.
-- Items someone has already counted stay with them.
create or replace function private.share_count_list(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype; v_people uuid[]; v_n int;
begin
  select * into v_shift from public.shifts where id = p_shift;
  select array_agg(user_id order by random()) into v_people from public.shift_counters where shift_id = p_shift and active;
  v_n := coalesce(array_length(v_people, 1), 0);

  -- Full-count shops: the whole range is the list
  if not exists (select 1 from public.shift_count_list where shift_id = p_shift) then
    insert into public.shift_count_list (shift_id, product_id, reason)
    select p_shift, p.id, 'Full count' from public.products p
    where p.business_id = v_shift.business_id and p.active
    on conflict do nothing;
  end if;

  with open_items as (
    select l.product_id, row_number() over (order by random()) - 1 as rn
    from public.shift_count_list l
    where l.shift_id = p_shift
      and not exists (select 1 from public.stock_counts c
                      where c.shift_id = p_shift and c.product_id = l.product_id
                        and c.count_type = 'closing' and c.source = 'counted')
  )
  update public.shift_count_list l
     set assigned_to = case when v_n = 0 then null else v_people[(o.rn % v_n) + 1] end
    from open_items o
   where l.shift_id = p_shift and l.product_id = o.product_id;
end $$;

-- Someone on site joins the count
create or replace function public.join_count(p_shift uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found or not private.can_access_shift(p_shift) then raise exception 'Shift not found' using errcode = 'P0002'; end if;
  if v_shift.status <> 'active' then raise exception 'You can join the count while the shift is open' using errcode = 'P0001'; end if;
  insert into public.shift_counters (shift_id, user_id, added_by) values (p_shift, auth.uid(), auth.uid())
  on conflict (shift_id, user_id) do update set active = true;
  perform private.share_count_list(p_shift);
end $$;

-- The person running the shift (or a manager) sets who is counting
create or replace function public.set_counters(p_shift uuid, p_users uuid[])
returns void language plpgsql security definer set search_path = ''
as $$
declare v_shift public.shifts%rowtype;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found or not private.can_access_shift(p_shift) then raise exception 'Shift not found' using errcode = 'P0002'; end if;
  if v_shift.opened_by <> auth.uid() and not private.is_manager(v_shift.business_id) then
    raise exception 'Only the person running the shift or a manager can choose who counts' using errcode = '42501';
  end if;
  if v_shift.status <> 'active' then raise exception 'You can share the count while the shift is open' using errcode = 'P0001'; end if;
  if coalesce(array_length(p_users, 1), 0) > 30 then raise exception 'Too many people' using errcode = '22023'; end if;
  if exists (select 1 from unnest(coalesce(p_users, '{}')) u
             where not exists (select 1 from public.memberships m join public.profiles pr on pr.id = m.user_id
                               where m.business_id = v_shift.business_id and m.user_id = u and m.active and pr.active)) then
    raise exception 'Everyone counting must be on your team' using errcode = '22023';
  end if;
  update public.shift_counters set active = (user_id = any(coalesce(p_users, '{}'))) where shift_id = p_shift;
  insert into public.shift_counters (shift_id, user_id, added_by)
  select p_shift, u, auth.uid() from unnest(coalesce(p_users, '{}')) u
  on conflict (shift_id, user_id) do update set active = true;
  perform private.share_count_list(p_shift);
end $$;

-- Who is counting, how much each has, and how far along they are
create or replace function public.count_progress(p_shift uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_access_shift(p_shift) then raise exception 'Shift not found' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', sc.user_id,
      'name', coalesce(nullif(pr.full_name, ''), 'Team member'),
      'assigned', (select count(*) from public.shift_count_list l where l.shift_id = p_shift and l.assigned_to = sc.user_id),
      'counted', (select count(*) from public.shift_count_list l where l.shift_id = p_shift and l.assigned_to = sc.user_id
                  and exists (select 1 from public.stock_counts c where c.shift_id = p_shift and c.product_id = l.product_id
                              and c.count_type = 'closing' and c.source = 'counted'))
    ) order by sc.added_at)
    from public.shift_counters sc join public.profiles pr on pr.id = sc.user_id
    where sc.shift_id = p_shift and sc.active), '[]'::jsonb);
end $$;

-- A closing count on a shared list must come from the person it was given to
-- (managers can count anything; recounts after a correction request are open).
create or replace function private.check_count_assignment()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_to uuid; v_status public.shift_status;
begin
  if new.count_type <> 'closing' or new.source <> 'counted' or auth.uid() is null then return new; end if;
  select assigned_to into v_to from public.shift_count_list where shift_id = new.shift_id and product_id = new.product_id;
  if v_to is null or v_to = auth.uid() then return new; end if;
  select status into v_status from public.shifts where id = new.shift_id;
  if v_status = 'correction_requested' or private.is_manager(new.business_id) then return new; end if;
  raise exception 'That product is on someone else''s count list tonight' using errcode = '42501';
end $$;

create trigger counts_check_assignment before insert on public.stock_counts
  for each row execute function private.check_count_assignment();

revoke execute on function private.share_count_list(uuid) from public, anon, authenticated;
revoke execute on function public.join_count(uuid) from public, anon;
revoke execute on function public.set_counters(uuid, uuid[]) from public, anon;
revoke execute on function public.count_progress(uuid) from public, anon;
grant execute on function public.join_count(uuid) to authenticated;
grant execute on function public.set_counters(uuid, uuid[]) to authenticated;
grant execute on function public.count_progress(uuid) to authenticated;
