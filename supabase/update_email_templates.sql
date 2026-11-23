-- Mails de confirmation et de demande de paiement : transport + total à payer.
-- À exécuter une fois dans Supabase > SQL Editor. Les autres modèles ne changent pas.
-- L'IBAN et le SWIFT/BIC viennent de Nastavenia > Bankové údaje (variables {iban} et {bic}).
update public.settings set value = jsonb_set(value, '{confirmation,body}', to_jsonb('Hi {first_name}!

Thank you for your order N°{order_no}. We have received it and we are preparing it.

{items}

Items: {total_eur} € / {total_czk} Kč
Shipping: {shipping_method}

We will calculate the shipping cost for your country and send you the total amount with the payment details in a separate email.

ADACTA'::text)), updated_at = now()
  where key = 'email_templates' and value ? 'confirmation';
update public.settings set value = jsonb_set(value, '{confirmation_sk,body}', to_jsonb('Ahoj {first_name}!

Ďakujeme za tvoju objednávku č. {order_no}. Prijali sme ju a pripravujeme ju.

{items}

Tovar: {total_eur} € / {total_czk} Kč
Doprava ({shipping_method}): {shipping_eur} € / {shipping_czk} Kč
Spolu na úhradu: {grand_total_eur} € / {grand_total_czk} Kč

Hneď ako bude balík na ceste, pošleme ti ďalší e-mail s číslom zásielky.

ADACTA'::text)), updated_at = now()
  where key = 'email_templates' and value ? 'confirmation_sk';
update public.settings set value = jsonb_set(value, '{payment,body}', to_jsonb('Hi {first_name}!

Thank you for your order N°{order_no}.

{items}

Items: {total_eur} €
Shipping ({shipping_method}): {shipping_eur} €
Total to pay: {grand_total_eur} €

Please send {grand_total_eur} € to the IBAN below, with your order number as reference. We will ship your parcel as soon as we receive it.

IBAN: {iban}
SWIFT/BIC: {bic}

ADACTA'::text)), updated_at = now()
  where key = 'email_templates' and value ? 'payment';
update public.settings set value = jsonb_set(value, '{payment_sk,body}', to_jsonb('Ahoj {first_name}!

Ďakujeme za tvoju objednávku č. {order_no}.

{items}

Tovar: {total_eur} € / {total_czk} Kč
Doprava ({shipping_method}): {shipping_eur} € / {shipping_czk} Kč
Spolu na úhradu: {grand_total_eur} € / {grand_total_czk} Kč

Prosím, pošli {grand_total_eur} € na IBAN nižšie a do poznámky uveď číslo objednávky. Balík odošleme hneď, ako platbu dostaneme.

IBAN: {iban}
SWIFT/BIC: {bic}

ADACTA'::text)), updated_at = now()
  where key = 'email_templates' and value ? 'payment_sk';
select key, jsonb_object_keys(value) as modele from public.settings where key = 'email_templates';
