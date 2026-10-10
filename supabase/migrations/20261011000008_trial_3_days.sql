-- New businesses get the Business plan free for 3 days, then drop to Free.
create or replace function public.create_business(p_name text, p_location_name text default 'Main store', p_standard_float numeric default 500)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_biz uuid; v_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Enter your business name' using errcode = '22023';
  end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;
  select email into v_email from auth.users where id = auth.uid();

  insert into public.businesses (name) values (trim(p_name)) returning id into v_biz;
  insert into public.locations (business_id, name, standard_float)
    values (v_biz, coalesce(nullif(trim(p_location_name), ''), 'Main store'), greatest(coalesce(p_standard_float, 0), 0));
  insert into public.memberships (business_id, user_id, role) values (v_biz, auth.uid(), 'owner');
  insert into public.subscriptions (business_id, plan, status, current_period_end, billing_email)
    values (v_biz, 'business', 'trialing', now() + interval '3 days', v_email);
  return v_biz;
end $$;
revoke execute on function public.create_business(text, text, numeric) from public, anon;
grant execute on function public.create_business(text, text, numeric) to authenticated;
