-- Demo engagement: which personal demo links get opened and how far people go.
-- Written by /api/demo-event with the service role; read on the admin page.
-- No policies: the browser can't read or write this table directly.
create table if not exists public.demo_events (
  id         bigint generated always as identity primary key,
  shop       text not null check (length(shop) between 1 and 80),
  kind       text not null check (kind in ('dispensary', 'bar')),
  event      text not null check (event in ('open', 'staff', 'submit', 'report', 'signup')),
  visitor    text check (visitor is null or length(visitor) <= 40),
  mobile     boolean,
  created_at timestamptz not null default now()
);
alter table public.demo_events enable row level security;
create index if not exists demo_events_created_idx on public.demo_events (created_at desc);
revoke all on public.demo_events from anon, authenticated;
grant select, insert on public.demo_events to service_role;
