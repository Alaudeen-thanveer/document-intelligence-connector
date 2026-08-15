-- Per-customer default account rules for invoices, mirroring
-- vendor_account_rules: "if customer is X, default the income account to Y"
-- unless the reviewer overrides it for that particular transaction.

create table public.customer_account_rules (
  id uuid primary key default gen_random_uuid(),
  -- One rule per Zoho customer contact.
  customer_zoho_id text not null unique,
  customer_name text not null,
  account_zoho_id text not null,
  account_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customer_account_rules enable row level security;

-- POC policies: reviewers manage rules from the dashboard (anon key).
-- Tighten with reviewer auth later.
create policy "customer_account_rules_select_poc"
  on public.customer_account_rules for select
  using (true);

create policy "customer_account_rules_insert_poc"
  on public.customer_account_rules for insert
  with check (true);

create policy "customer_account_rules_update_poc"
  on public.customer_account_rules for update
  using (true)
  with check (true);

create policy "customer_account_rules_delete_poc"
  on public.customer_account_rules for delete
  using (true);

grant select, insert, update, delete
  on table public.customer_account_rules to anon, authenticated;
grant select, insert, update, delete
  on table public.customer_account_rules to service_role;
