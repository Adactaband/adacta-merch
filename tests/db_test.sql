-- Test du schéma sur un PostgreSQL local (après tests/supabase_stub.sql puis supabase/schema.sql)
\set ON_ERROR_STOP 1
insert into allowed_emails values ('admin@test.cz', 'admin'), ('membre@test.cz', 'member') on conflict do nothing;
select import_order('{"source_key":"t1","submitted_at":"2026-11-16T07:15:06+01:00","email":"jana@test.cz","first_name":"Jana",
  "items":[{"product":"Misanthropunk t-shirt","size":"XL","qty":2,"unit_eur":18,"unit_czk":450},
           {"product":"Beanie","qty":1,"unit_eur":15,"unit_czk":380}]}'::jsonb) as import1;
select import_order('{"source_key":"t1","first_name":"Autre","items":[]}'::jsonb) as reimport;   -- ne doit rien écraser
do $$ declare v record; begin
  select * into v from orders_view where source_key = 't1';
  assert v.first_name = 'Jana', 'le réimport a écrasé le prénom';
  assert v.items_count = 3 and v.subtotal_eur = 51 and v.discount_eur_effective = -6 and v.total_eur = 45, 'totaux faux';
  assert v.total_czk = 1280 - 140, 'total Kč faux';
  assert v.order_no = 672, 'numérotation automatique : ' || coalesce(v.order_no::text, 'vide');
end $$;
-- un N° venant du Sheet est gardé, la suite continue après le plus grand
select import_order('{"source_key":"t2","order_no":680,"submitted_at":"2026-11-17T10:00:00+01:00","email":"b@test.cz","items":[]}'::jsonb);
select import_order('{"source_key":"t3","submitted_at":"2026-11-18T10:00:00+01:00","email":"c@test.cz","items":[]}'::jsonb);
do $$ begin
  assert (select order_no from orders where source_key = 't2') = 680, 'N° du Sheet perdu';
  assert (select order_no from orders where source_key = 't3') = 681, 'suite de la numérotation';
end $$;
-- ancien fonctionnement (N° lus dans Gmail) si la numérotation automatique est coupée
update settings set value = '{"auto": false}' where key = 'numbering';
select import_order('{"source_key":"t4","submitted_at":"2026-11-19T10:00:00+01:00","email":"d@test.cz","items":[]}'::jsonb);
do $$ begin
  assert (select order_no from orders where source_key = 't4') is null, 'numérotation non coupée';
  assert assign_order_no(990, 'd@test.cz', '2026-11-19T09:15:20Z', 'm1') is not null, 'N° Gmail non attribué';
end $$;
update settings set value = '{"auto": true, "first": 672}' where key = 'numbering';
set role authenticated;
set request.jwt.claims = '{"email":"intrus@test.cz"}';
do $$ begin assert (select count(*) from orders) = 0, 'un intrus voit les commandes'; end $$;
set request.jwt.claims = '{"email":"membre@test.cz"}';
update orders set status = 'emballee' where source_key = 't1';
do $$ begin
  assert (select changed_by from status_history where new_status = 'emballee' limit 1) = 'membre@test.cz', 'historique';
end $$;
-- Katalóg : les membres le consultent sans le modifier, les admins le modifient
reset role;
insert into products(name, price_eur) values ('Test patch', 5) on conflict do nothing;
set role authenticated;
set request.jwt.claims = '{"email":"membre@test.cz"}';
do $$ begin
  assert (select count(*) from products) > 0, 'un membre ne voit pas le catalogue';
  assert (select count(*) from categories) > 0, 'un membre ne voit pas les catégories';
end $$;
update products set price_eur = 99 where name = 'Test patch';
delete from categories;
do $$ begin
  assert (select price_eur from products where name = 'Test patch') = 5, 'un membre a modifié un article';
  assert (select count(*) from categories) > 0, 'un membre a supprimé des catégories';
  begin insert into products(name) values ('Intrus'); assert false, 'un membre a créé un article';
  exception when insufficient_privilege then null; end;
  begin insert into categories(name, position) values ('Intrus', 9); assert false, 'un membre a créé une catégorie';
  exception when insufficient_privilege then null; end;
  begin perform import_products('[{"name":"Intrus 2"}]'::jsonb); assert false, 'un membre a importé des articles';
  exception when raise_exception then null; end;
  begin insert into settings(key, value) values ('product_types', '[]') on conflict (key) do update set value = excluded.value;
    assert false, 'un membre a modifié les types d''article';
  exception when insufficient_privilege then null; end;
  begin insert into sync_requests(kind) values ('form_publish'); assert false, 'un membre a publié le Google Form';
  exception when insufficient_privilege then null; end;
end $$;
insert into sync_requests(kind) values ('sync');                                      -- la synchro reste ouverte aux membres
insert into settings(key, value) values ('bank', '{"iban":"x"}') on conflict (key) do update set value = excluded.value;
set request.jwt.claims = '{"email":"admin@test.cz"}';
update products set price_eur = 6 where name = 'Test patch';
insert into categories(name, position) values ('Admin test', 9);
insert into sync_requests(kind) values ('form_preview');
update settings set value = '[]' where key = 'product_types';
do $$ begin
  assert (select price_eur from products where name = 'Test patch') = 6, 'un admin ne peut pas modifier un article';
  assert import_products('[{"name":"Admin import t-shirt","sizes":["M"]}]'::jsonb) = 1, 'un admin ne peut pas importer';
end $$;
reset role;
select 'TOUS LES TESTS SQL PASSENT' as resultat;
