-- Extend the Zoho entity cache with the remaining posting masters:
-- taxes (VAT), bank/cash accounts, payment terms, items, users.

alter table public.zoho_entities
  drop constraint zoho_entities_kind_check;

alter table public.zoho_entities
  add constraint zoho_entities_kind_check
  check (
    kind in (
      'account',
      'vendor',
      'customer',
      'reporting_tag',
      'currency',
      'project',
      'tax',
      'bank_account',
      'payment_term',
      'item',
      'user'
    )
  );
