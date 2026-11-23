-- Katalóg = articles du Google Form « Adacta Merch Order » (relevé du 21.11.2026)
-- À exécuter dans Supabase > SQL Editor, après schema.sql. Peut être relancé sans risque :
-- - les 29 articles du formulaire sont actifs (SOLD OUT gardé), avec prix, type, textile, catégorie et ordre du formulaire ;
-- - le poids n'est rempli que s'il est vide (valeurs estimées, à corriger dans Katalóg) ;
-- - les tailles ne sont remplies que si l'article n'en a aucune ;
-- - tous les autres articles (anciennes colonnes de la Sheet) passent en inactif ; ils restent visibles avec « Zobraziť aj neaktívny tovar ».
begin;

-- sous-catégories utilisées par le formulaire
do $$
declare tee bigint;
begin
  select c.id into tee from public.categories c join public.categories p on p.id = c.parent_id
   where c.name = 'Tričká / T-shirts' and p.name = 'Oblečenie / Clothing';
  if tee is not null then
    insert into public.categories(parent_id, name, position) values (tee, 'Misanthropunk', 1), (tee, 'Raven', 2)
    on conflict (parent_id, name) do nothing;
  end if;
end $$;

create temp table form_items(name text, pos int, eur numeric, czk numeric, type text, textile boolean,
                             sold_out boolean, weight int, cat text[], sizes text[]) on commit drop;
insert into form_items values
  ('Misanthropunk t-shirt', 0, 18, 450, 'T-shirt', true, false, 220, array['Oblečenie / Clothing', 'Tričká / T-shirts', 'Misanthropunk'], array['S', 'M', 'L', 'XL', 'XXL', '3XL']::text[]),
  ('Misanthropunk Zipper Hoodie', 1, 40, 1000, 'Zipper hoodie', true, false, 650, array['Oblečenie / Clothing', 'Mikiny / Hoodies'], array['S', 'M', 'L', 'XL', 'XXL', '3XL']::text[]),
  ('Misanthropunk Crewneck', 2, 35, 880, 'Crewneck', true, false, 550, array['Oblečenie / Clothing', 'Mikiny / Hoodies'], array['S', 'M', 'L', 'XL', 'XXL', '3XL']::text[]),
  ('Misanthropunk Back Patch', 3, 12, 300, 'Patch', false, false, 20, array['Doplnky / Accessories', 'Nášivky / Patches'], array[]::text[]),
  ('Oversized Fanny Pack', 4, 20, 500, 'Bag', false, true, 250, array['Doplnky / Accessories', 'Tašky / Bags'], array[]::text[]),
  ('Snake t-shirt', 5, 18, 450, 'T-shirt', true, false, 220, array['Oblečenie / Clothing', 'Tričká / T-shirts'], array['S', 'M', 'L', 'XL', 'XXL', '3XL']::text[]),
  ('Antikopf t-shirt', 6, 18, 450, 'T-shirt', true, true, 220, array['Oblečenie / Clothing', 'Tričká / T-shirts'], array['S', 'M', 'L', 'XL', 'XXL', '3XL']::text[]),
  ('Raven Zipper Hoodie', 7, 40, 1000, 'Zipper hoodie', true, false, 650, array['Oblečenie / Clothing', 'Mikiny / Hoodies'], array['S', 'M', 'L', 'XL', 'XXL', '3XL']::text[]),
  ('Raven Crewneck', 8, 35, 880, 'Crewneck', true, false, 550, array['Oblečenie / Clothing', 'Mikiny / Hoodies'], array['S', 'M', 'L', 'XL', 'XXL', '3XL']::text[]),
  ('Raven Longsleeve', 9, 25, 630, 'Longsleeve', true, false, 300, array['Oblečenie / Clothing', 'Longsleeve'], array['S', 'M', 'L', 'XL', 'XXL', '3XL']::text[]),
  ('Raven T-Shirt', 10, 18, 450, 'T-shirt', true, false, 220, array['Oblečenie / Clothing', 'Tričká / T-shirts', 'Raven'], array['S', 'M', 'L', 'XL', 'XXL', '3XL']::text[]),
  ('хуй Любош T-Shirt', 11, 18, 450, 'T-shirt', true, true, 220, array['Oblečenie / Clothing', 'Tričká / T-shirts'], array['S', 'M', 'L', 'XL', 'XXL', '3XL']::text[]),
  ('ADACTA plays DISFEAR - A Brutal Sight of War Live - Gray Splatter LP', 12, 20, 500, 'LP', false, false, 320, array['Hudba / Music', 'Vinyl'], array[]::text[]),
  ('ADACTA plays DISFEAR - A Brutal Sight of War Live - White LP', 13, 20, 500, 'LP', false, false, 320, array['Hudba / Music', 'Vinyl'], array[]::text[]),
  ('ADACTA - Dno - Black LP', 14, 20, 500, 'LP', false, false, 320, array['Hudba / Music', 'Vinyl'], array[]::text[]),
  ('ADACTA - Zlo - Black LP', 15, 15, 380, 'LP', false, false, 320, array['Hudba / Music', 'Vinyl'], array[]::text[]),
  ('ADACTA - Tma - Ultra Clear Splatter LP', 16, 20, 500, 'LP', false, false, 320, array['Hudba / Music', 'Vinyl'], array[]::text[]),
  ('ADACTA - Tma - Silver Splatter LP', 17, 20, 500, 'LP', false, false, 320, array['Hudba / Music', 'Vinyl'], array[]::text[]),
  ('ADACTA - Ad Maiorem Dei Gloriam - LP', 18, 15, 380, 'LP', false, false, 320, array['Hudba / Music', 'Vinyl'], array[]::text[]),
  ('ADACTA - Circullus Viciosus - LP', 19, 15, 380, 'LP', false, false, 320, array['Hudba / Music', 'Vinyl'], array[]::text[]),
  ('Antikopf Embroided Patch 7x7,7 cm', 20, 8, 200, 'Patch', false, false, 20, array['Doplnky / Accessories', 'Nášivky / Patches'], array[]::text[]),
  ('Embroided Back Patch 30 cm', 21, 17, 430, 'Patch', false, false, 20, array['Doplnky / Accessories', 'Nášivky / Patches'], array[]::text[]),
  ('Tma Back Patch', 22, 12, 300, 'Patch', false, false, 20, array['Doplnky / Accessories', 'Nášivky / Patches'], array[]::text[]),
  ('Trucker Hat', 23, 17, 430, 'Headwear', false, false, 100, array['Doplnky / Accessories', 'Čiapky / Headwear'], array[]::text[]),
  ('Beanie', 24, 15, 380, 'Headwear', false, false, 100, array['Doplnky / Accessories', 'Čiapky / Headwear'], array[]::text[]),
  ('Horda Embroided Patch', 25, 9, 230, 'Patch', false, false, 20, array['Doplnky / Accessories', 'Nášivky / Patches'], array[]::text[]),
  ('Gryphon Embroided Patch', 26, 9, 230, 'Patch', false, false, 20, array['Doplnky / Accessories', 'Nášivky / Patches'], array[]::text[]),
  ('Raven Embroided Patch', 27, 9, 230, 'Patch', false, false, 20, array['Doplnky / Accessories', 'Nášivky / Patches'], array[]::text[]),
  ('Logo Embroided Patch', 28, 6, 150, 'Patch', false, false, 20, array['Doplnky / Accessories', 'Nášivky / Patches'], array[]::text[]);

-- catégorie : chemin de noms → id
create temp table form_cat on commit drop as
select f.name, coalesce(c3.id, c2.id, c1.id) as category_id
from form_items f
left join public.categories c1 on c1.parent_id is null and c1.name = f.cat[1]
left join public.categories c2 on c2.parent_id = c1.id and c2.name = f.cat[2]
left join public.categories c3 on c3.parent_id = c2.id and c3.name = f.cat[3];

-- articles absents de la base : création
insert into public.products(name, price_eur, price_czk, sizes, active, sold_out, from_form, position, type, textile)
select f.name, f.eur, f.czk, f.sizes, true, f.sold_out, true, f.pos, f.type, f.textile
from form_items f
where not exists (select 1 from public.products p
                  where lower(translate(p.name, chr(160), ' ')) = lower(f.name));

-- mise à jour des articles du formulaire
update public.products p set
  active = true, sold_out = f.sold_out, from_form = true, position = f.pos,
  price_eur = f.eur, price_czk = f.czk, type = f.type, textile = f.textile,
  category_id = coalesce(fc.category_id, p.category_id),
  weight_g = coalesce(p.weight_g, f.weight),
  sizes = case when coalesce(cardinality(p.sizes), 0) = 0 then f.sizes else p.sizes end,
  updated_at = now()
from form_items f join form_cat fc on fc.name = f.name
where lower(translate(p.name, chr(160), ' ')) = lower(f.name);

-- le reste : inactif
update public.products p set active = false, updated_at = now()
where p.active and not exists (select 1 from form_items f where lower(translate(p.name, chr(160), ' ')) = lower(f.name));

commit;

select count(*) filter (where active) as actifs, count(*) filter (where active and sold_out) as sold_out,
       count(*) filter (where not active) as inactifs, count(*) filter (where active and category_id is null) as sans_categorie
from public.products;
