-- Product categories (Flower, Pre-rolls, Edibles, ...) for the product list,
-- uploads and reports. Sample-menu products get theirs from the SKU prefix.
alter table public.products add column if not exists category text;
alter table public.products drop constraint if exists products_category_len;
alter table public.products add constraint products_category_len check (category is null or length(category) <= 40);

create or replace function private.product_category_default()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.category is null or btrim(new.category) = '' then
    new.category := case
      when new.sku like 'FL-%' then 'Flower'
      when new.sku like 'PR-%' then 'Pre-rolls'
      when new.sku like 'ED-%' then 'Edibles'
      when new.sku like 'VP-%' or new.sku like 'EX-%' then 'Vapes & extracts'
      else null end;
  else
    new.category := btrim(new.category);
  end if;
  return new;
end $$;

drop trigger if exists products_category_default on public.products;
create trigger products_category_default before insert or update of category on public.products
  for each row execute function private.product_category_default();

update public.products set category = case
  when sku like 'FL-%' then 'Flower' when sku like 'PR-%' then 'Pre-rolls' when sku like 'ED-%' then 'Edibles'
  when sku like 'VP-%' or sku like 'EX-%' then 'Vapes & extracts' end
where category is null and (sku like 'FL-%' or sku like 'PR-%' or sku like 'ED-%' or sku like 'VP-%' or sku like 'EX-%');
