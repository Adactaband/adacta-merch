-- Katalóg réservé aux admins (à exécuter une fois dans Supabase > SQL Editor ; peut être relancé sans risque).
-- Les membres consultent toujours le Katalóg (articles, catégories, photos), mais seuls les admins
-- peuvent créer, modifier ou supprimer des articles, des catégories, des photos, les types d'article,
-- et publier dans le Google Form. Le script Google (clé secret = service_role) n'est pas concerné.
-- Ces règles sont aussi dans schema.sql : inutile de lancer ce fichier après une installation neuve.
begin;

do $$
declare t text;
begin
  -- Katalóg (articles, catégories) : toute l'équipe le consulte, seuls les admins le modifient
  foreach t in array array['products', 'categories'] loop
    execute format('drop policy if exists team_all on public.%I', t);
    execute format('drop policy if exists team_read on public.%I', t);
    execute format('drop policy if exists admin_write on public.%I', t);
    execute format('create policy team_read on public.%I for select to authenticated using (public.is_allowed())', t);
    execute format('create policy admin_write on public.%I for all to authenticated
                    using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- Réglages : les types d'article (Katalóg) et le Google Form sont réservés aux admins
drop policy if exists team_all on public.settings;
drop policy if exists team_read on public.settings;
drop policy if exists team_write on public.settings;
create policy team_read on public.settings for select to authenticated using (public.is_allowed());
create policy team_write on public.settings for all to authenticated
  using (public.is_admin() or (public.is_allowed() and key not in ('product_types', 'google_form')))
  with check (public.is_admin() or (public.is_allowed() and key not in ('product_types', 'google_form')));

-- Demandes au script Google : « sync » pour toute l'équipe, publication dans le Google Form pour les admins
drop policy if exists team_all on public.sync_requests;
drop policy if exists team_read on public.sync_requests;
drop policy if exists team_insert on public.sync_requests;
drop policy if exists team_update on public.sync_requests;
drop policy if exists team_delete on public.sync_requests;
create policy team_read on public.sync_requests for select to authenticated using (public.is_allowed());
create policy team_insert on public.sync_requests for insert to authenticated
  with check (public.is_allowed() and (kind = 'sync' or public.is_admin()));
create policy team_update on public.sync_requests for update to authenticated
  using (public.is_allowed()) with check (public.is_allowed() and (kind = 'sync' or public.is_admin()));
create policy team_delete on public.sync_requests for delete to authenticated using (public.is_allowed());

-- Photos (bucket « product-photos ») : ajout et suppression réservés aux admins
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then return; end if;
  execute 'drop policy if exists product_photos_write on storage.objects';
  execute $p$create policy product_photos_write on storage.objects for all to authenticated
           using (bucket_id = 'product-photos' and public.is_admin())
           with check (bucket_id = 'product-photos' and public.is_admin())$p$;
end $$;

-- Fonctions d'import : admins pour le catalogue, équipe pour les commandes, script Google ou SQL Editor.
-- (corrige aussi un contrôle qui laissait passer n'importe quel compte connecté)
create or replace function public.is_backend() returns boolean
language sql stable as $$
  select coalesce(auth.role(), '') = 'service_role' or coalesce(auth.jwt(), '{}'::jsonb) = '{}'::jsonb
$$;

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
  if not (public.is_allowed() or public.is_backend()) then
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

create or replace function public.import_products(p jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare it jsonb; n integer := 0;
begin
  if not (public.is_admin() or public.is_backend()) then
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

create or replace function public.assign_order_no(p_order_no integer, p_email text,
                                                  p_sent_at timestamptz, p_message_id text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not (public.is_allowed() or public.is_backend()) then
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

grant execute on function public.is_backend() to authenticated, service_role;

commit;
