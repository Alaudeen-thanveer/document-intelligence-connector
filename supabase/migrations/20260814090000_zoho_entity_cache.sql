-- Zoho entity cache (pull step): chart of accounts, vendors, customers.
-- The zoho-pull edge function refreshes these rows from Zoho Books; the
-- review dashboard reads them to populate the posting dropdowns.

create table public.zoho_entities (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('account', 'vendor', 'customer')),
  zoho_id text not null,
  name text not null,
  -- Extra attributes per kind (e.g. account_type for accounts, status for contacts).
  extra jsonb,
  synced_at timestamptz not null default now(),
  unique (kind, zoho_id)
);

create index zoho_entities_kind_idx on public.zoho_entities (kind);

alter table public.zoho_entities enable row level security;

-- POC read policy (dashboard uses anon key); tighten with reviewer auth later.
create policy "zoho_entities_select_poc"
  on public.zoho_entities for select
  using (true);

grant select on table public.zoho_entities to anon, authenticated;
grant select, insert, update, delete on table public.zoho_entities to service_role;
