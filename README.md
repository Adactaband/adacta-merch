# ADACTA merch · Suivi des commandes

Site de suivi des commandes merch d'ADACTA.

- **Site** : HTML/JS statique hébergé gratuitement sur **GitHub Pages**.
- **Base de données** : **Supabase** (PostgreSQL), qui gère aussi la connexion. Seules les adresses de la liste autorisée voient les données. Ce contrôle est appliqué directement dans la base.
- **Lien avec Google** : un **script Google Apps Script** installé sur le compte `adactaband666@gmail.com`. Il importe les réponses du Google Form (Sheet), met à jour le Google Form à partir du Katalóg et envoie les mails préparés sur le site.

```
Google Form ─► Google Sheet ─┐
Google Form ◄── Katalóg ─────┼── script Google (adactaband666) ◄─► Supabase (PostgreSQL) ◄─► site GitHub Pages
Mails clients ◄──────────────┘          (toutes les 1 à 15 min)                                  (équipe)
```

## Ce que fait le site

| Page | Contenu |
|---|---|
| **Commandes** | Compteurs par statut, recherche, filtres (**date du … au …**, statut, pays SK / CZ / autres, livraison, **Dobierka / Platba vopred**, payé), bouton « Zrušiť filtre ». Colonne **Zapl.** : mode de paiement (SK et CZ = Dobierka, autres pays = Platba vopred) et case à cliquer quand l'argent est reçu (✓ vert). Changement de statut en un clic, actions groupées (statut, payé, mail), export CSV, commande saisie à la main |
| **Fiche commande** | Client et adresse modifiables, point Packeta, note du client, articles choisis dans le Katalóg (menus article et taille ; « autre » pour un article libre), case « préparé », article **manquant** avec note, remise, **dobierka** (auto / oui / non), **poids et frais de transport** (calculés avec la grille, modifiables), total en € et Kč, transporteur et N° de suivi avec lien, notes internes, envoi de mail à partir d'un modèle, historique des statuts et des mails |
| **À préparer** | Tableau des articles à préparer par article et par taille, avec les N° de commande (comme le fichier Excel), imprimable, et la liste des articles manquants |
| **Katalóg** | Les articles séparés en **Textile** et **Non textile** (LP, patchs, accessoires), avec filtres par catégorie, type et recherche. Fiche article : **photos** (glisser-déposer, photo principale), **catégorie › sous-catégorie › sous-sous-catégorie**, **type** (LP, CD, MC, Patch, T-shirt, Hoodie…), case **Textile**, **tailles à cocher de S à 4XL + Unisize**, **version Girly** avec ses propres tailles, prix € et Kč, **poids** (g), actif / SOLD OUT. Gestion des catégories et des types en bas de page. Clic sur la photo pour l'agrandir. Bouton **Mettre à jour le Google Form** |
| **Doprava (Transport)** | Grille des frais de port : par transporteur, une colonne par pays (`*` = autres pays), une ligne par tranche de poids (« jusqu'à X kg »), prix en € et en Kč, plus une ligne **Dobierka** (frais ajoutés au port quand la commande est payée à la livraison). Poids de l'emballage ajouté à chaque colis |
| **Réglages** | **Confirmation de commande automatique** pour chaque nouvelle réponse au formulaire (SK/CZ en slovaque, sinon en anglais ; case à cocher), personnes autorisées, expéditeur des mails (envoyés depuis adactaband666@gmail.com ; **copie cachée à tous les utilisateurs du site**, case activée par défaut), modèles de mails, liens de suivi Packeta/DPD/poste, remises automatiques (ex. Misanthropunk) |

Le site est en **slovaque et en anglais** (bouton SK / EN en haut à droite ; slovaque par défaut pour un navigateur slovaque ou tchèque). Les modèles de mails existent dans les deux langues : sur la fiche, la version SK est proposée pour les clients slovaques et tchèques, la version EN pour les autres. Les traductions de l’interface sont dans `assets/i18n.js`.

Statuts : **Non traitée → En préparation → Emballée → Envoyée → Livrée / archivée**, plus **Nevyzdvihnutá** (colis non retiré par le client, reste dans « Na spracovanie » pour le suivi), **En attente** (paiement, réponse du client…) et **Annulée**. « Paiement reçu » est une case séparée.

**Synchronisation** : toutes les 15 minutes, ou en cliquant sur « Synchroniser » (moins d'une minute). L'import n'écrase jamais une modification faite sur le site. Il remplit seulement les champs vides et n'ajoute les articles qu'à une commande qui n'en a encore aucun.

**Articles du formulaire** : toute colonne du Sheet qui n'est pas une information client est lue comme un article. Le nom et le prix viennent de l'intitulé (ex. `Misanthropunk t-shirt - 18 eur / 450 Kč`), la taille vient de la réponse. Un article ajouté au Google Form apparaît donc tout seul. Retirer une question ou la passer en « SOLD OUT » ne change pas les commandes déjà importées.

**Commandes importées** : seulement les réponses à partir du **15/09/2026** (propriété `IMPORT_FROM`). Avec les données actuelles : 34 commandes, N° 640 à 673.

**N° de commande** : c'est maintenant **le site qui numérote**. Une nouvelle réponse au formulaire, ou une commande saisie à la main, reçoit le N° suivant (674, 675…). Les N° déjà présents dans la colonne `ORDER N°` du Sheet sont gardés. Les réponses du 14/11 et du 16/11, sans N° dans le Sheet, reçoivent 672 et 673, comme dans les mails déjà envoyés. Réglage `numbering` dans la table `settings`.
⚠️ Désactive le module qui envoyait les mails « Merch order N°… » depuis le formulaire, sinon il continue avec sa propre numérotation. Le mail **Confirmation de commande** du site contient le N° (`{order_no}`).

**Photos du formulaire** : à chaque synchronisation, le script copie la photo de chaque question du Google Form dans le Katalóg, pour les articles qui n'ont encore aucune photo. Les photos ajoutées ou choisies sur le site ne sont jamais remplacées. Google ne fournit pas ces images aux scripts : elles sont lues dans la page publique du formulaire.

**En-tête du formulaire** : dans Katalóg → « Hlavička Google formulára », on modifie le **titre** et la **description** du formulaire ; le script les applique en moins d'une minute. L'image d'en-tête est affichée, mais Google ne permet pas de la changer par script : elle se change dans l'éditeur du formulaire (Thème).

**Photos** : stockées dans Supabase Storage (bucket public `product-photos`, créé par `schema.sql`), réduites à 1200 px avant l'envoi. Tout le monde peut voir une photo par son lien ; seules les personnes autorisées peuvent en ajouter ou en retirer.

**Tailles** : S, M, L, XL, XXL, 3XL, 4XL et Unisize. Les tailles du formulaire sont normalisées à l'import (XXXL → 3XL, XXXXL → 4XL, « one size » → Unisize). La coupe Girly s'écrit « Girly M » dans les commandes et dans le formulaire. À l'import, le type de chaque article est deviné d'après son nom (LP, Patch, T-shirt…), et il est classé textile s'il a des tailles.

**Frais de transport** : poids de la commande = somme des poids du Katalóg × quantités + emballage. Le site prend dans la grille la plus petite tranche qui contient ce poids, pour le transporteur de la commande (ou celui déduit du mode de livraison : Packeta, DPD) et le pays du client. Le montant peut être remplacé à la main sur la fiche. Il s'ajoute au total.

**Katalóg → Google Form** : le bouton **Mettre à jour le Google Form** enregistre le Katalóg, puis affiche la liste des changements avant de publier : prix et nom dans l'intitulé des questions, liste des tailles, `SOLD OUT!` pour un article épuisé, ajout d'une question pour un nouvel article (copie d'une question existante), suppression des articles inactifs. Le script applique les changements en moins d'une minute. Les commandes déjà importées ne changent pas. Il faut que `adactaband666@gmail.com` soit **éditeur du Google Form**.

**Mails** : quand on clique sur « Envoyer », le mail est mis en file d'attente. Le script l'envoie au plus 1 minute après, depuis le Gmail du compte où il est installé.

---

## Mise en place (environ 30 minutes, une seule fois)

### 1. Supabase : la base de données

1. Crée un compte sur [supabase.com](https://supabase.com), puis **New project** (région *Central EU (Frankfurt)*, plan gratuit). Note le mot de passe de la base quelque part.
2. Ouvre **SQL Editor → New query**, colle tout le contenu de [`supabase/schema.sql`](supabase/schema.sql), puis clique sur **Run**.
3. Toujours dans le SQL Editor, déclare-toi administrateur (avec ta propre adresse) :
   ```sql
   insert into public.allowed_emails(email, role) values ('ton.adresse@gmail.com', 'admin');
   ```
   Tu pourras ensuite ajouter les autres adresses depuis la page **Réglages** du site.
4. Dans **Authentication → Hooks**, ajoute un hook **Before User Created** de type *Postgres function* et choisis `public.hook_before_user_created`. Ainsi, une adresse hors liste ne peut même pas créer de compte.
5. Dans **Authentication → Sign In / Providers → Email**, la connexion par lien magique est active par défaut.
   ⚠️ Le service mail intégré de Supabase n'envoie qu'aux membres de ton équipe Supabase, avec un nombre limité de mails par heure. Pour que tout le groupe reçoive son lien de connexion, branche le Gmail du groupe dans **Authentication → Emails → SMTP Settings** :
   - Host `smtp.gmail.com`, Port `465`, Username `adactaband666@gmail.com`
   - Password : un **mot de passe d'application** Google ([myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), la validation en 2 étapes doit être activée)
   - Sender email `adactaband666@gmail.com`, Sender name `ADACTA`
   *(Option : tu peux aussi activer le fournisseur **Google** pour un bouton « Se connecter avec Google ». Il faut alors créer un client OAuth dans Google Cloud et mettre `googleLogin: true` dans `config.js`.)*
6. Dans **Project Settings → API Keys**, note :
   - la clé **publishable** (`sb_publishable_…`, ou l'ancienne clé *anon*) : elle va dans `config.js` ;
   - la clé **secret** (`sb_secret_…`, ou l'ancienne clé *service_role*) : elle va **uniquement** dans le script Google. Ne la mets jamais dans le site ni sur GitHub.
   Note aussi l'**URL du projet** (`https://xxxx.supabase.co`).

### 1 bis. Catalogue = Google Form

Après le premier import du script (étape 3), exécute [`supabase/catalog_from_form.sql`](supabase/catalog_from_form.sql) dans le SQL Editor : il aligne le Katalóg sur les 29 articles du formulaire (actifs, SOLD OUT, prix, type, catégorie, ordre, poids estimés si vides) et passe les anciens articles en inactif. Il peut être relancé sans risque.

### 2. GitHub Pages : le site

1. Crée un dépôt GitHub (ex. `adacta-merch`). Il peut être public, puisqu'il ne contient aucune donnée ni aucun secret. GitHub Pages sur un dépôt privé demande un compte payant.
2. Mets-y tous les fichiers de ce dossier (bouton **Add file → Upload files**, ou `git push`).
3. Remplis `config.js` avec l'URL du projet et la clé publishable.
4. **Settings → Pages** : *Source = Deploy from a branch*, branche `main`, dossier `/ (root)`. Le site sera à l'adresse `https://<ton-compte>.github.io/adacta-merch/`.
5. Retourne dans Supabase, **Authentication → URL Configuration** : mets cette adresse dans **Site URL** et dans **Redirect URLs**.

### 3. Script Google : import et envoi des mails

À faire **connecté au compte `adactaband666@gmail.com`** (les mails partiront de ce compte) :

1. Le Google Sheet des réponses (« Adacta Merch Order 241207 ») appartient à un autre compte : partage-le en **lecture** avec `adactaband666@gmail.com`. Partage aussi le **Google Form** avec ce compte, en **éditeur** (dans le Form : ⋮ → Ajouter des collaborateurs), pour les tailles et la mise à jour depuis le Katalóg.
2. Va sur [script.google.com](https://script.google.com) → **Nouveau projet**, nomme-le « ADACTA suivi commandes ».
3. Remplace le contenu de `Code.gs` par celui de [`google-apps-script/Code.gs`](google-apps-script/Code.gs).
4. **Paramètres du projet** (roue dentée) → **Propriétés du script** → ajoute :

   | Propriété | Valeur |
   |---|---|
   | `SUPABASE_URL` | `https://xxxx.supabase.co` |
   | `SUPABASE_SECRET_KEY` | la clé secret de l'étape 1.6 |
   | `SHEET_ID` | `1ATUxUq_SkQo_ryUjS00jry5LCFMzioobiyUZTfzwDZg` |
   | `IMPORT_FROM` *(optionnel)* | `2026-09-15` par défaut : les réponses plus anciennes ne sont pas importées |

5. Dans l'éditeur, choisis la fonction **`setup`** puis **Exécuter**. Accepte les autorisations demandées (Sheets, Gmail, accès externe). Google affiche « application non validée » : clique sur *Paramètres avancés → Accéder au projet*. C'est normal pour un script personnel.
   `setup` lance un premier import complet et crée les déclencheurs automatiques : la file de mails et le bouton « Synchroniser » toutes les minutes, l'import complet toutes les 15 minutes.

Connecte-toi au site : les commandes sont là.

---

## Utilisation au quotidien

1. Une commande arrive par le formulaire. Elle apparaît en **Non traitée** au plus tard 15 minutes après (ou tout de suite avec « Synchroniser »).
2. Optionnel : envoie le mail **Confirmation de commande** depuis la fiche, ou à plusieurs commandes à la fois depuis la liste.
3. Page **À préparer** : imprime la liste des articles et coche « préparé » sur les fiches au fur et à mesure.
4. Passe la commande en **Emballée**, saisis le N° de suivi Packeta/DPD, puis envoie le mail **Commande expédiée (suivi)**. La case « Passer en Envoyée » est cochée automatiquement.

Les modèles de mails (SK et EN) sont modifiables dans **Réglages**. Variables disponibles : `{first_name}` `{order_no}` `{items}` `{missing_items}` `{total_eur}` `{total_czk}` `{weight_kg}` `{shipping_eur}` `{grand_total_eur}` `{grand_total_czk}` `{tracking_number}` `{tracking_url}` `{shipping_method}` `{pickup_point}` `{address}`…

Avant la première utilisation : renseigne le **poids** de chaque article dans **Katalóg** et les tarifs dans **Doprava**, sinon les frais de port restent à saisir à la main.

## Aperçu sans installation

Ouvre le site avec `config.js` vide : il démarre en **mode démo** avec des commandes fictives. Rien n'est enregistré ni envoyé. Il faut le servir en HTTP (ex. `python3 -m http.server` dans ce dossier, puis http://localhost:8000).

## Tests

```bash
node --test tests/parser.test.cjs         # lecture du Google Sheet et des mails
# schéma SQL sur un PostgreSQL local :
psql -d test -f tests/supabase_stub.sql -f supabase/schema.sql -f tests/db_test.sql
node tests/ui-smoke.cjs /tmp             # parcours du site en mode démo (Playwright)
```

## Fichiers

```
index.html, config.js, assets/       le site (GitHub Pages)
supabase/schema.sql                  tables, sécurité, import, réglages par défaut
google-apps-script/Code.gs           script Google (import Sheet + Gmail, envoi des mails)
tests/                               tests automatiques
```
