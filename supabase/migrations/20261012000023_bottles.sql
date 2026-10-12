-- Bars and lounges: spirits are kept in ml and counted by weighing the open
-- bottle. The owner enters, once per product, the empty bottle's weight
-- (container_weight, already used for jars), a full sealed bottle's weight
-- and the bottle size in ml. The app turns a scale reading into ml:
--   ml = (reading - empty) * bottle_ml / (full - empty)
-- so no density table is needed and liqueurs work as well as spirits.
alter table public.products add column if not exists full_weight numeric(10,3) check (full_weight is null or full_weight > 0);
alter table public.products add column if not exists bottle_ml numeric(10,3) check (bottle_ml is null or bottle_ml > 0);
