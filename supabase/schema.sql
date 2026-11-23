-- =====================================================================
--  Adacta Merch · Suivi des commandes · schéma Supabase (PostgreSQL)
--  À coller tel quel dans Supabase > SQL Editor > New query > Run.
--  Le script peut être relancé : il ne supprime aucune donnée.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Liste des adresses autorisées à se connecter
-- ---------------------------------------------------------------------
create table if not exists public.allowed_emails (
  email      text primary key check (email = lower(email)),
  role       text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now()
);

-- Adresse de la personne connectée (lue dans le jeton Supabase Auth)
create or replace function public.current_email() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowed_emails where email = public.current_email())
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowed_emails
                 where email = public.current_email() and role = 'admin')
$$;

-- ---------------------------------------------------------------------
-- 2. Commandes
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id              bigint generated always as identity primary key,
  source_key      text unique,              -- horodatage + email de la réponse au formulaire
  order_no        integer unique,           -- N° de commande (Sheet ou mail « Merch order N° »)
  submitted_at    timestamptz,
  email           text,
  first_name      text,
  last_name       text,
  company         text,
  street          text,
  postal_code     text,
  city            text,
  country         text,
  phone           text,
  social          text,
  shipping_method text,
  pickup_point    text,
  customer_notes  text,
  status          text not null default 'non_traitee'
                  check (status in ('non_traitee', 'en_attente', 'en_preparation',
                                    'emballee', 'envoyee', 'nevyzdvihnute', 'livree', 'annulee')),
  paid            boolean not null default false,
  carrier         text,                     -- packeta, dpd, posta, main_propre…
  tracking_number text,
  discount_eur    numeric(10,2),            -- négatif, ex. -8 ; null = calcul automatique
  discount_czk    numeric(10,2),
  internal_notes  text,
  sheet_status    text,                     -- colonne « POdané ? » du Sheet
  gmail_message_id text,
  raw             jsonb,                    -- réponse brute du formulaire
  shipped_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- Frais de transport (null = montant par défaut du mode de livraison, voir Réglages)
alter table public.orders add column if not exists shipping_eur numeric(10,2);
alter table public.orders add column if not exists shipping_czk numeric(10,2);
create index if not exists orders_status_idx on public.orders(status);
create index if not exists orders_submitted_idx on public.orders(submitted_at desc);

create table if not exists public.order_items (
  id        bigint generated always as identity primary key,
  order_id  bigint not null references public.orders(id) on delete cascade,
  product   text not null,
  size      text,
  qty       integer not null default 1 check (qty > 0),
  unit_eur  numeric(10,2),
  unit_czk  numeric(10,2),
  prepared  boolean not null default false,
  position  integer not null default 0
);
create index if not exists order_items_order_idx on public.order_items(order_id);
-- Article indisponible au moment de l'emballage
alter table public.order_items add column if not exists missing boolean not null default false;
alter table public.order_items add column if not exists missing_note text;   -- ex. « recommandé, arrive le 5/12 »
alter table public.order_items add column if not exists missing_since timestamptz;

create or replace function public.order_items_missing_since() returns trigger
language plpgsql as $$
begin
  if new.missing and (tg_op = 'INSERT' or not old.missing) then new.missing_since := now(); end if;
  if not new.missing then new.missing_since := null; end if;
  return new;
end $$;
drop trigger if exists order_items_missing_since on public.order_items;
create trigger order_items_missing_since before insert or update of missing on public.order_items
for each row execute function public.order_items_missing_since();

create table if not exists public.status_history (
  id         bigint generated always as identity primary key,
  order_id   bigint not null references public.orders(id) on delete cascade,
  old_status text,
  new_status text not null,
  changed_by text,
  changed_at timestamptz not null default now()
);
create index if not exists status_history_order_idx on public.status_history(order_id);

alter table if exists public.products add column if not exists weight_g integer;

-- Catégories du merch : catégorie › sous-catégorie › sous-sous-catégorie (3 niveaux)
create table if not exists public.categories (
  id        bigint generated always as identity primary key,
  parent_id bigint references public.categories(id) on delete restrict,
  name      text not null,
  position  integer not null default 0,
  unique (parent_id, name)
);

create or replace function public.categories_check_depth() returns trigger
language plpgsql as $$
declare d integer := 1; p bigint := new.parent_id;
begin
  while p is not null loop
    if p = new.id then raise exception 'une catégorie ne peut pas être dans elle-même'; end if;
    d := d + 1;
    select parent_id into p from public.categories where id = p;
  end loop;
  if d > 3 then raise exception '3 niveaux de catégories au maximum'; end if;
  return new;
end $$;
drop trigger if exists categories_check_depth on public.categories;
create trigger categories_check_depth before insert or update on public.categories
for each row execute function public.categories_check_depth();

-- Catalogue : articles du Google Form (importés), modifiables sur le site
create table if not exists public.products (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  price_eur  numeric(10,2),
  price_czk  numeric(10,2),
  sizes      text[] not null default '{}',     -- vide = article sans taille
  active     boolean not null default true,     -- proposé dans les menus des commandes
  sold_out   boolean not null default false,
  weight_g   integer,                           -- poids emballé d'une pièce, en grammes
  from_form  boolean not null default false,
  position   integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.products add column if not exists weight_g integer;
-- classement, type, textile, tailles Girly, photos
alter table public.products add column if not exists category_id bigint references public.categories(id) on delete set null;
alter table public.products add column if not exists type text;               -- LP, CD, Patch, T-shirt… (liste dans settings.product_types)
alter table public.products add column if not exists textile boolean not null default false;
alter table public.products add column if not exists girly_sizes text[] not null default '{}';  -- coupe Girly : tailles disponibles
alter table public.products add column if not exists photos text[] not null default '{}';       -- URL publiques, la 1re = photo principale
-- lien avec la question du Google Form (rempli par le script à la publication)
alter table public.products add column if not exists form_item_id bigint;
alter table public.products add column if not exists form_title text;
alter table public.products add column if not exists form_synced_at timestamptz;

-- Grille des frais de transport : pour un transporteur et un pays (« * » = autres
-- pays), le prix de la plus petite tranche dont le poids maximal couvre le colis.
create table if not exists public.shipping_rates (
  id           bigint generated always as identity primary key,
  carrier      text not null,             -- packeta, dpd, posta…
  country      text not null,             -- SK, CZ, AT… ou * pour les autres pays
  max_weight_g integer not null check (max_weight_g > 0),
  price_eur    numeric(10,2),
  price_czk    numeric(10,2),
  unique (carrier, country, max_weight_g)
);

-- Dobierka (paiement à la livraison) : frais ajoutés aux frais de port, par transporteur
-- et par pays (« * » = autres pays)
create table if not exists public.cod_fees (
  id        bigint generated always as identity primary key,
  carrier   text not null,
  country   text not null,
  price_eur numeric(10,2),
  price_czk numeric(10,2),
  unique (carrier, country)
);
-- Dobierka par commande : null = déduit du mode de livraison (« … dobierkou »), sinon oui / non
alter table public.orders add column if not exists cod boolean;

-- Pays saisi librement par le client → code (SK, CZ, AT…), * si inconnu
create or replace function public.country_code(p text) returns text
language sql immutable as $$
  select case
    when p ~* '(slovensk|slovak|zlovensk|^\s*(sk|svk)\s*$)' then 'SK'
    when p ~* '(česk|cesk|czech|^\s*(cz|cr|čr|cze)\s*$)' then 'CZ'
    when p ~* '(rakús|rakus|rakous|austria|österreich|osterreich|^\s*at\s*$)' then 'AT'
    when p ~* '(maďar|madar|hungar|magyar|^\s*hu\s*$)' then 'HU'
    when p ~* '(poľsk|polsk|poland|^\s*pl\s*$)' then 'PL'
    when p ~* '(nemeck|němec|nemec|german|deutschland|^\s*de\s*$)' then 'DE'
    when p ~* '(franc|^\s*fr\s*$)' then 'FR'
    else '*' end
$$;

-- ---------------------------------------------------------------------
-- 3. Mails : file d'envoi lue par le script Google (compte adactaband666)
-- ---------------------------------------------------------------------
create table if not exists public.email_outbox (
  id           bigint generated always as identity primary key,
  order_id     bigint references public.orders(id) on delete set null,
  kind         text not null default 'custom',   -- confirmation, expedition, custom
  to_email     text not null,
  cc           text,
  subject      text not null,
  body_text    text not null,
  status       text not null default 'pending' check (status in ('pending', 'sent', 'error', 'cancelled')),
  error        text,
  requested_by text default public.current_email(),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index if not exists email_outbox_pending_idx on public.email_outbox(status) where status = 'pending';

-- Demandes de synchronisation (bouton « Synchroniser » du site)
create table if not exists public.sync_requests (
  id           bigint generated always as identity primary key,
  requested_by text default public.current_email(),
  created_at   timestamptz not null default now(),
  done_at      timestamptz,
  result       jsonb
);
-- sync = import Sheet + Gmail ; form_preview / form_publish = Katalóg → Google Form
alter table public.sync_requests add column if not exists kind text not null default 'sync';
alter table public.sync_requests drop constraint if exists sync_requests_kind_check;
alter table public.sync_requests add constraint sync_requests_kind_check
  check (kind in ('sync', 'form_preview', 'form_publish', 'form_header'));
alter table public.sync_requests add column if not exists payload jsonb;   -- ex. nouvel en-tête du formulaire

-- Réglages (modèles de mails, remises, liens de suivi…)
create table if not exists public.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. Vue des totaux par commande
-- ---------------------------------------------------------------------
create or replace function public.auto_discount(p_order_id bigint)
returns table (eur numeric, czk numeric)
language sql stable security definer set search_path = public as $$
  -- Chaque règle : {"match": ["misanthropunk", "t-shirt"], "eur": 3, "czk": 70}
  -- s'applique à chaque article dont le nom contient TOUS les mots de "match".
  with rules as (
    select r from public.settings s, jsonb_array_elements(s.value) r
    where s.key = 'discount_rules' and jsonb_typeof(s.value) = 'array'
  ), hits as (
    select i.qty,
           (select r from rules
             where not exists (
               select 1 from jsonb_array_elements_text(r -> 'match') m
               where position(lower(m) in lower(i.product)) = 0)
             limit 1) as r
    from public.order_items i where i.order_id = p_order_id
  )
  select coalesce(-sum(qty * coalesce((r ->> 'eur')::numeric, 0)), 0),
         coalesce(-sum(qty * coalesce((r ->> 'czk')::numeric, 0)), 0)
  from hits where r is not null
$$;

drop view if exists public.orders_view;
create view public.orders_view with (security_invoker = true) as
select o.*,
       coalesce(t.items_count, 0)  as items_count,
       coalesce(t.subtotal_eur, 0) as subtotal_eur,
       coalesce(t.subtotal_czk, 0) as subtotal_czk,
       coalesce(o.discount_eur, d.eur, 0) as discount_eur_effective,
       coalesce(o.discount_czk, d.czk, 0) as discount_czk_effective,
       coalesce(t.subtotal_eur, 0) + coalesce(o.discount_eur, d.eur, 0) as total_eur,
       coalesce(t.subtotal_czk, 0) + coalesce(o.discount_czk, d.czk, 0) as total_czk,
       trim(coalesce(o.first_name, '') || ' ' || coalesce(o.last_name, '')) as customer_name,
       coalesce(t.items_summary, '') as items_summary,
       coalesce(t.missing_count, 0) as missing_count,
       public.country_code(o.country) as country_code,
       w.weight_g, coalesce(w.weight_unknown, false) as weight_unknown,
       (o.shipping_eur is null and r.rate is null and k.carrier is distinct from 'main_propre') as shipping_unknown,
       k.cod as cod_effective,
       case when k.cod then coalesce(cf.eur, 0) else 0 end as cod_eur,
       case when k.cod then coalesce(cf.czk, 0) else 0 end as cod_czk,
       coalesce(o.shipping_eur, coalesce((r.rate ->> 'eur')::numeric, 0) + case when k.cod then coalesce(cf.eur, 0) else 0 end) as shipping_eur_effective,
       coalesce(o.shipping_czk, coalesce((r.rate ->> 'czk')::numeric, 0) + case when k.cod then coalesce(cf.czk, 0) else 0 end) as shipping_czk_effective,
       coalesce(t.subtotal_eur, 0) + coalesce(o.discount_eur, d.eur, 0)
         + coalesce(o.shipping_eur, coalesce((r.rate ->> 'eur')::numeric, 0) + case when k.cod then coalesce(cf.eur, 0) else 0 end) as grand_total_eur,
       coalesce(t.subtotal_czk, 0) + coalesce(o.discount_czk, d.czk, 0)
         + coalesce(o.shipping_czk, coalesce((r.rate ->> 'czk')::numeric, 0) + case when k.cod then coalesce(cf.czk, 0) else 0 end) as grand_total_czk
from public.orders o
cross join lateral (
  -- paiement : SK / CZ = dobierka, autres pays = platba vopred (sauf choix manuel sur la commande)
  select coalesce(o.cod, coalesce(o.shipping_method, '') ~* '(dobierk|cash on delivery|\mcod\M)'
                         or public.country_code(o.country) in ('SK', 'CZ')) as cod,
         coalesce(nullif(o.carrier, ''), case when o.shipping_method ilike '%dpd%' then 'dpd'
                                              when o.shipping_method ilike '%packeta%' then 'packeta' end) as carrier
) k
left join lateral (
  select sum(qty) as items_count,
         sum(qty * coalesce(unit_eur, 0)) as subtotal_eur,
         sum(qty * coalesce(unit_czk, 0)) as subtotal_czk,
         string_agg(product || coalesce(' ' || size, '') || case when qty > 1 then ' ×' || qty else '' end,
                    ' · ' order by position, id) as items_summary,
         sum(qty) filter (where missing) as missing_count
  from public.order_items i where i.order_id = o.id
) t on true
left join lateral public.auto_discount(o.id) d on true
left join lateral (
  select coalesce(sum(i.qty * p.weight_g), 0)
         + coalesce((select (value ->> 'packaging_g')::int from public.settings where key = 'shipping'), 0) as weight_g,
         bool_or(p.weight_g is null) as weight_unknown
  from public.order_items i left join public.products p on lower(p.name) = lower(i.product)
  where i.order_id = o.id
) w on true
left join lateral (
  select jsonb_build_object('eur', sr.price_eur, 'czk', sr.price_czk) as rate
  from public.shipping_rates sr
  where sr.carrier = k.carrier
    and sr.country in (public.country_code(o.country), '*')
    and sr.max_weight_g >= w.weight_g
  order by (sr.country = '*'), sr.max_weight_g
  limit 1
) r on true
left join lateral (
  select c.price_eur as eur, c.price_czk as czk from public.cod_fees c
  where c.carrier = k.carrier and c.country in (public.country_code(o.country), '*')
  order by (c.country = '*') limit 1
) cf on true;

-- ---------------------------------------------------------------------
-- 5. Déclencheurs : date de mise à jour + historique des statuts
-- ---------------------------------------------------------------------
create or replace function public.orders_before_update() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'envoyee' and old.status is distinct from 'envoyee' and new.shipped_at is null then
    new.shipped_at := now();
  end if;
  return new;
end $$;

-- Numérotation : une commande créée sans N° (nouvelle réponse au formulaire ou
-- commande saisie sur le site) reçoit le N° suivant : plus grand N° existant + 1,
-- jamais moins que settings.numbering.first. Les N° déjà connus sont gardés.
create or replace function public.orders_assign_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare cfg jsonb;
begin
  if new.order_no is not null then return new; end if;
  select value into cfg from settings where key = 'numbering';
  if coalesce((cfg ->> 'auto')::boolean, true) is false then return new; end if;
  perform pg_advisory_xact_lock(hashtext('adacta_order_no'));
  select greatest(coalesce(max(order_no), 0) + 1, coalesce((cfg ->> 'first')::int, 1))
    into new.order_no from orders;
  return new;
end $$;

drop trigger if exists orders_assign_no on public.orders;
create trigger orders_assign_no before insert on public.orders
for each row execute function public.orders_assign_no();

drop trigger if exists orders_before_update on public.orders;
create trigger orders_before_update before update on public.orders
for each row execute function public.orders_before_update();

create or replace function public.orders_log_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.status_history(order_id, old_status, new_status, changed_by)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status,
            coalesce(nullif(public.current_email(), ''), 'import'));
  end if;
  return new;
end $$;

drop trigger if exists orders_log_status on public.orders;
create trigger orders_log_status after insert or update of status on public.orders
for each row execute function public.orders_log_status();

-- ---------------------------------------------------------------------
-- 6. Import depuis le Google Sheet (appelé par le script Google)
--    N'écrase jamais une modification faite sur le site : les champs
--    ne sont remplis que s'ils sont vides, les articles seulement si
--    la commande n'en a encore aucun.
-- ---------------------------------------------------------------------
create or replace function public.import_order(p jsonb)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_new boolean := false;
  v_order_no integer := nullif(p ->> 'order_no', '')::integer;
  v_status text := coalesce(nullif(p ->> 'status', ''), 'non_traitee');
  it jsonb;
  n integer := 0;
begin
  if not (public.is_allowed() or coalesce(auth.role(), '') = 'service_role'
          or current_user in ('postgres', 'service_role')) then
    raise exception 'accès refusé';
  end if;

  -- un N° déjà pris par une autre réponse n'est pas réattribué
  if v_order_no is not null and exists (
       select 1 from orders where order_no = v_order_no and source_key is distinct from p ->> 'source_key') then
    v_order_no := null;
  end if;

  select id into v_id from orders where source_key = p ->> 'source_key';

  if v_id is null then
    insert into orders (source_key, order_no, submitted_at, email, first_name, last_name, company,
                        street, postal_code, city, country, phone, social, shipping_method,
                        pickup_point, customer_notes, sheet_status, status, raw)
    values (p ->> 'source_key', v_order_no, (p ->> 'submitted_at')::timestamptz, lower(p ->> 'email'),
            p ->> 'first_name', p ->> 'last_name', p ->> 'company', p ->> 'street', p ->> 'postal_code',
            p ->> 'city', p ->> 'country', p ->> 'phone', p ->> 'social', p ->> 'shipping_method',
            p ->> 'pickup_point', p ->> 'customer_notes', p ->> 'sheet_status', v_status, p -> 'raw')
    returning id into v_id;
    v_new := true;
  else
    update orders set
      order_no        = coalesce(order_no, v_order_no),
      email           = coalesce(nullif(email, ''), lower(p ->> 'email')),
      first_name      = coalesce(nullif(first_name, ''), p ->> 'first_name'),
      last_name       = coalesce(nullif(last_name, ''), p ->> 'last_name'),
      company         = coalesce(nullif(company, ''), p ->> 'company'),
      street          = coalesce(nullif(street, ''), p ->> 'street'),
      postal_code     = coalesce(nullif(postal_code, ''), p ->> 'postal_code'),
      city            = coalesce(nullif(city, ''), p ->> 'city'),
      country         = coalesce(nullif(country, ''), p ->> 'country'),
      phone           = coalesce(nullif(phone, ''), p ->> 'phone'),
      social          = coalesce(nullif(social, ''), p ->> 'social'),
      shipping_method = coalesce(nullif(shipping_method, ''), p ->> 'shipping_method'),
      pickup_point    = coalesce(nullif(pickup_point, ''), p ->> 'pickup_point'),
      customer_notes  = coalesce(nullif(customer_notes, ''), p ->> 'customer_notes'),
      sheet_status    = p ->> 'sheet_status',
      raw             = p -> 'raw'
    where id = v_id;
  end if;

  if not exists (select 1 from order_items where order_id = v_id) then
    for it in select * from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) loop
      insert into order_items (order_id, product, size, qty, unit_eur, unit_czk, position)
      values (v_id, it ->> 'product', nullif(it ->> 'size', ''), coalesce((it ->> 'qty')::int, 1),
              nullif(it ->> 'unit_eur', '')::numeric, nullif(it ->> 'unit_czk', '')::numeric, n);
      n := n + 1;
    end loop;
  end if;

  return case when v_new then 'created' else 'updated' end;
end $$;

-- Catalogue depuis le formulaire : ajoute les nouveaux articles et les
-- nouvelles tailles ; ne change jamais un prix ni un nom modifié sur le site.
-- Type d'article deviné d'après son nom (à l'import ; modifiable dans le Katalóg)
create or replace function public.guess_type(p text) returns text
language sql immutable as $$
  select case
    when p ~* 'patch|nášivka' then 'Patch'
    -- un lot « LP + T-shirt » est rangé avec le textile, pour proposer les tailles
    when p ~* 'zip+er' then 'Zipper hoodie'
    when p ~* 'hoodie|mikina' then 'Hoodie'
    when p ~* 'crewneck' then 'Crewneck'
    when p ~* 'longsleeve|long sleeve' then 'Longsleeve'
    when p ~* 't-?shirt|\mtee\M|tričko' then 'T-shirt'
    when p ~* '\m(lp|vinyl)\M' then 'LP'
    when p ~* '\mcd\M' then 'CD'
    when p ~* 'cas+et+e|kazeta|\mmc\M' then 'MC'
    when p ~* 'beanie|\mhat\M|\mcap\M|balaclava|čiapka|kukla' then 'Headwear'
    when p ~* 'bag|tote|fanny|taška|ľadvinka' then 'Bag'
    else null end
$$;

create or replace function public.import_products(p jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare it jsonb; n integer := 0;
begin
  if not (public.is_allowed() or coalesce(auth.role(), '') = 'service_role'
          or current_user in ('postgres', 'service_role')) then
    raise exception 'accès refusé';
  end if;
  for it in select * from jsonb_array_elements(p) loop
    insert into products (name, price_eur, price_czk, sizes, girly_sizes, active, sold_out, from_form, position, type, textile)
    values (it ->> 'name', nullif(it ->> 'price_eur', '')::numeric, nullif(it ->> 'price_czk', '')::numeric,
            coalesce(array(select jsonb_array_elements_text(it -> 'sizes')), '{}'),
            coalesce(array(select jsonb_array_elements_text(it -> 'girly_sizes')), '{}'),
            coalesce((it ->> 'active')::boolean, true), coalesce((it ->> 'sold_out')::boolean, false), true,
            coalesce((it ->> 'position')::int, 0),
            public.guess_type(it ->> 'name'),
            coalesce(jsonb_array_length(it -> 'sizes'), 0) + coalesce(jsonb_array_length(it -> 'girly_sizes'), 0) > 0
              or public.guess_type(it ->> 'name') in ('T-shirt', 'Longsleeve', 'Hoodie', 'Zipper hoodie', 'Crewneck'))
    on conflict (name) do update set
      sizes = (select coalesce(array_agg(distinct x), '{}') from unnest(products.sizes || excluded.sizes) x),
      girly_sizes = (select coalesce(array_agg(distinct x), '{}') from unnest(products.girly_sizes || excluded.girly_sizes) x),
      sold_out = excluded.sold_out,
      active = products.active or excluded.active,
      updated_at = now()
    where products.from_form;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Attribue un N° de commande trouvé dans un mail « Merch order N°… » :
-- même adresse client, réponse la plus proche dans le temps (± 6 h).
create or replace function public.assign_order_no(p_order_no integer, p_email text,
                                                  p_sent_at timestamptz, p_message_id text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not (public.is_allowed() or coalesce(auth.role(), '') = 'service_role'
          or current_user in ('postgres', 'service_role')) then
    raise exception 'accès refusé';
  end if;
  if exists (select 1 from orders where order_no = p_order_no) then
    return null;
  end if;
  select id into v_id from orders
   where order_no is null and lower(email) = lower(p_email)
     and submitted_at between p_sent_at - interval '6 hours' and p_sent_at + interval '1 hour'
   order by abs(extract(epoch from (p_sent_at - submitted_at)))
   limit 1;
  if v_id is not null then
    update orders set order_no = p_order_no, gmail_message_id = p_message_id where id = v_id;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 7. Sécurité : seules les adresses autorisées voient et modifient
-- ---------------------------------------------------------------------
alter table public.allowed_emails enable row level security;
alter table public.orders         enable row level security;
alter table public.order_items    enable row level security;
alter table public.status_history enable row level security;
alter table public.email_outbox   enable row level security;
alter table public.sync_requests  enable row level security;
alter table public.settings       enable row level security;
alter table public.products       enable row level security;
alter table public.shipping_rates enable row level security;
alter table public.cod_fees       enable row level security;
alter table public.categories     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['orders', 'order_items', 'status_history', 'email_outbox',
                           'sync_requests', 'settings', 'products', 'shipping_rates', 'categories', 'cod_fees'] loop
    execute format('drop policy if exists team_all on public.%I', t);
    execute format('create policy team_all on public.%I for all to authenticated
                    using (public.is_allowed()) with check (public.is_allowed())', t);
  end loop;
end $$;

drop policy if exists allowed_read on public.allowed_emails;
create policy allowed_read on public.allowed_emails for select to authenticated
  using (public.is_allowed());
drop policy if exists allowed_admin on public.allowed_emails;
create policy allowed_admin on public.allowed_emails for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

revoke all on all tables in schema public from anon;
revoke execute on function public.import_order(jsonb) from anon, public;
revoke execute on function public.import_products(jsonb) from anon, public;
grant execute on function public.import_products(jsonb) to authenticated, service_role;
revoke execute on function public.assign_order_no(integer, text, timestamptz, text) from anon, public;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- le script Google (clé secret = rôle service_role) lit et écrit toutes les tables
-- (les nouveaux projets Supabase ne donnent plus ces droits automatiquement)
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on function public.import_order(jsonb) to authenticated, service_role;
grant execute on function public.assign_order_no(integer, text, timestamptz, text) to authenticated, service_role;
grant execute on function public.is_allowed(), public.is_admin(), public.current_email() to authenticated, anon;

-- ---------------------------------------------------------------------
-- 8. Réglages par défaut (modifiables ensuite dans l'onglet Réglages)
-- ---------------------------------------------------------------------
insert into public.settings(key, value) values
-- 672 et 673 ont été envoyés par l'ancien module mail (réponses du 14 et 16/11/2026, sans N° dans
-- le Sheet) : l'import chronologique les leur redonne, puis les nouvelles commandes partent de 674.
('numbering', '{"auto": true, "first": 672}'::jsonb),
-- Google Form « Adacta Merch Order » (le script met ces liens à jour à chaque import)
('google_form', '{"view_url": "https://docs.google.com/forms/d/1YxQzbESLF-PS7lLEy__SVM7D0cHOof2_4obaQJNwWXE/viewform", "edit_url": "https://docs.google.com/forms/d/1YxQzbESLF-PS7lLEy__SVM7D0cHOof2_4obaQJNwWXE/edit", "title": "Adacta Merch Order", "description": ""}'::jsonb),
-- Types d'article : textile = tailles proposées (S à 4XL, Unisize, Girly)
('product_types', '[
  {"name": "LP", "textile": false}, {"name": "CD", "textile": false}, {"name": "MC", "textile": false},
  {"name": "Patch", "textile": false}, {"name": "Bag", "textile": false}, {"name": "Headwear", "textile": false},
  {"name": "Accessory", "textile": false},
  {"name": "T-shirt", "textile": true}, {"name": "Longsleeve", "textile": true}, {"name": "Hoodie", "textile": true},
  {"name": "Zipper hoodie", "textile": true}, {"name": "Crewneck", "textile": true}
]'::jsonb),
('discount_rules', '[
  {"match": ["misanthropunk", "t-shirt"],      "eur": 3, "czk": 70},
  {"match": ["misanthropunk", "zipper hoodie"], "eur": 5, "czk": 120},
  {"match": ["misanthropunk", "crewneck"],      "eur": 5, "czk": 120}
]'::jsonb),
('shipping', '{"packaging_g": 0}'::jsonb),
('tracking_urls', '{
  "packeta": "https://tracking.packeta.com/sk/?id={tracking}",
  "dpd": "https://tracking.dpd.de/status/en_US/parcel/{tracking}",
  "posta": "https://tandt.posta.sk/zasielky/{tracking}",
  "ceska_posta": "https://www.postaonline.cz/trackandtrace/-/zasilka/cislo?parcelNumbers={tracking}"
}'::jsonb),
('bank', '{"iban": "", "bic": ""}'::jsonb),
('email', '{
  "sender_name": "ADACTA",
  "cc": "",
  "reply_to": "",
  "bcc_users": true,
  "auto_confirm": true
}'::jsonb),
('email_templates', '{
  "confirmation": {
    "label": "Order confirmation · EN",
    "subject": "ADACTA merch · order N°{order_no} confirmed",
    "body": "Hi {first_name}!\n\nThank you for your order N°{order_no}. We have received it and we are preparing it.\n\n{items}\n\nItems: {total_eur} € / {total_czk} Kč\nShipping: {shipping_method}\n\nWe will calculate the shipping cost for your country and send you the total amount with the payment details in a separate email.\n\nADACTA"
  },
  "confirmation_sk": {
    "label": "Potvrdenie objednávky · SK",
    "subject": "ADACTA merch · objednávka č. {order_no} potvrdená",
    "body": "Ahoj {first_name}!\n\nĎakujeme za tvoju objednávku č. {order_no}. Prijali sme ju a pripravujeme ju.\n\n{items}\n\nTovar: {total_eur} € / {total_czk} Kč\nDoprava ({shipping_method}): {shipping_eur} € / {shipping_czk} Kč\nSpolu na úhradu: {grand_total_eur} € / {grand_total_czk} Kč\n\nHneď ako bude balík na ceste, pošleme ti ďalší e-mail s číslom zásielky.\n\nADACTA"
  },
  "expedition": {
    "label": "Order shipped · EN",
    "subject": "ADACTA merch · order N°{order_no} shipped",
    "body": "Hi {first_name}!\n\nYour order N°{order_no} is on its way.\n\nTracking number: {tracking_number}\nTrack your parcel: {tracking_url}\n\n{items}\n\nThank you for supporting us!\n\nADACTA"
  },
  "expedition_sk": {
    "label": "Objednávka odoslaná · SK",
    "subject": "ADACTA merch · objednávka č. {order_no} odoslaná",
    "body": "Ahoj {first_name}!\n\nTvoja objednávka č. {order_no} je na ceste.\n\nČíslo zásielky: {tracking_number}\nSledovanie zásielky: {tracking_url}\n\n{items}\n\nĎakujeme za podporu!\n\nADACTA"
  },
  "payment": {
    "label": "Payment request · EN",
    "subject": "ADACTA merch · order N°{order_no} · payment",
    "body": "Hi {first_name}!\n\nThank you for your order N°{order_no}.\n\n{items}\n\nItems: {total_eur} €\nShipping ({shipping_method}): {shipping_eur} €\nTotal to pay: {grand_total_eur} €\n\nPlease send {grand_total_eur} € to the IBAN below, with your order number as reference. We will ship your parcel as soon as we receive it.\n\nIBAN: {iban}\nSWIFT/BIC: {bic}\n\nADACTA"
  },
  "payment_sk": {
    "label": "Žiadosť o platbu · SK",
    "subject": "ADACTA merch · objednávka č. {order_no} · platba",
    "body": "Ahoj {first_name}!\n\nĎakujeme za tvoju objednávku č. {order_no}.\n\n{items}\n\nTovar: {total_eur} € / {total_czk} Kč\nDoprava ({shipping_method}): {shipping_eur} € / {shipping_czk} Kč\nSpolu na úhradu: {grand_total_eur} € / {grand_total_czk} Kč\n\nProsím, pošli {grand_total_eur} € na IBAN nižšie a do poznámky uveď číslo objednávky. Balík odošleme hneď, ako platbu dostaneme.\n\nIBAN: {iban}\nSWIFT/BIC: {bic}\n\nADACTA"
  },
  "missing": {
    "label": "Missing item · EN",
    "subject": "ADACTA merch · order N°{order_no} · item unavailable",
    "body": "Hi {first_name}!\n\nWhile packing your order N°{order_no}, we found that this item is currently unavailable:\n\n{missing_items}\n\nWe are sorry about that. Please reply to this email and tell us what you prefer:\n- wait until it is back in stock (we will send everything together),\n- replace it with another item or size,\n- or remove it from your order.\n\nADACTA"
  },
  "missing_sk": {
    "label": "Chýbajúci tovar · SK",
    "subject": "ADACTA merch · objednávka č. {order_no} · tovar nedostupný",
    "body": "Ahoj {first_name}!\n\nPri balení tvojej objednávky č. {order_no} sme zistili, že tento tovar momentálne nie je dostupný:\n\n{missing_items}\n\nMrzí nás to. Odpíš nám prosím na tento e-mail, čo uprednostňuješ:\n- počkať, kým bude opäť skladom (pošleme všetko spolu),\n- vymeniť ho za iný tovar alebo veľkosť,\n- alebo ho z objednávky vyradiť.\n\nADACTA"
  }
}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 9. (Recommandé) Bloquer la création de comptes hors liste autorisée
--    À activer dans Supabase > Authentication > Hooks >
--    « Before User Created » > Postgres function > public.hook_before_user_created
-- ---------------------------------------------------------------------
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.allowed_emails
             where email = lower(coalesce(event -> 'user' ->> 'email', ''))) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Cette adresse n''est pas autorisée à accéder au suivi des commandes.'));
end $$;
revoke execute on function public.hook_before_user_created(jsonb) from anon, authenticated, public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
    grant select on public.allowed_emails to supabase_auth_admin;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 10. Premier administrateur : remplace l'adresse puis exécute cette ligne
-- ---------------------------------------------------------------------
-- insert into public.allowed_emails(email, role) values ('ton.adresse@gmail.com', 'admin');


-- ---------------------------------------------------------------------
-- 9. Catégories de départ (seulement si la table est vide) et photos
-- ---------------------------------------------------------------------
do $$
declare music bigint; clothes bigint; acc bigint;
begin
  if exists (select 1 from public.categories) then return; end if;
  insert into public.categories(name, position) values ('Hudba / Music', 1) returning id into music;
  insert into public.categories(name, position) values ('Oblečenie / Clothing', 2) returning id into clothes;
  insert into public.categories(name, position) values ('Doplnky / Accessories', 3) returning id into acc;
  insert into public.categories(parent_id, name, position) values
    (music, 'Vinyl', 1), (music, 'CD', 2), (music, 'MC', 3),
    (clothes, 'Tričká / T-shirts', 1), (clothes, 'Mikiny / Hoodies', 2), (clothes, 'Longsleeve', 3),
    (acc, 'Nášivky / Patches', 1), (acc, 'Čiapky / Headwear', 2), (acc, 'Tašky / Bags', 3);
end $$;

-- Photos : bucket public « product-photos » de Supabase Storage. Tout le monde peut voir
-- une photo (lien), seules les personnes autorisées peuvent en ajouter ou en retirer.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then return; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('product-photos', 'product-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do nothing;
  execute 'drop policy if exists product_photos_write on storage.objects';
  execute $p$create policy product_photos_write on storage.objects for all to authenticated
           using (bucket_id = 'product-photos' and public.is_allowed())
           with check (bucket_id = 'product-photos' and public.is_allowed())$p$;
end $$;

-- Statut « Nevyzdvihnuté » (colis non retiré) : mise à jour de la contrainte sur une base existante
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('non_traitee', 'en_attente', 'en_preparation', 'emballee', 'envoyee', 'nevyzdvihnute', 'livree', 'annulee'));
