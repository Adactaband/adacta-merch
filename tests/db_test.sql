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
reset role;
select 'TOUS LES TESTS SQL PASSENT' as resultat;
