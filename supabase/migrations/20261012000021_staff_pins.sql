-- Staff PINs: a 4–6 digit PIN per person to confirm their shift answers, so
-- people can confirm on a shared shop phone without typing a full password.
-- The PIN is hashed by the server (scrypt) and this table is readable and
-- writable only by the server (no policies for app users).

create table if not exists public.staff_pins (
  user_id      uuid primary key references public.profiles(id),
  pin_hash     text not null,
  failed       int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.staff_pins enable row level security;

-- Record how each statement was confirmed
alter table public.shift_statements add column if not exists pin_confirmed boolean not null default false;
