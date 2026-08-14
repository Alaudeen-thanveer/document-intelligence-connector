-- Extend the Zoho entity cache with reporting tags, currencies, and projects
-- so zoho-pull can sync them and the review UI can offer them when posting.

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
      'project'
    )
  );
