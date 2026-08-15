-- Per-vendor default account rules: "if vendor is X, default the GL account
-- to Y". Applied when posting unless the reviewer overrides the account for
-- that particular transaction. Replaces the global ZOHO_DEFAULT_ACCOUNT_ID /
-- env ZOHO_EXPENSE_CATEGORY fallbacks — there is no global default account.

create table public.vendor_account_rules (
  id uuid primary key default gen_random_uuid(),
  -- One rule per Zoho vendor contact.
  vendor_zoho_id text not null unique,
  vendor_name text not null,
  account_zoho_id text not null,
  account_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vendor_account_rules enable row level security;

-- POC policies: reviewers manage rules from the dashboard (anon key).
-- Tighten with reviewer auth later.
create policy "vendor_account_rules_select_poc"
  on public.vendor_account_rules for select
  using (true);

create policy "vendor_account_rules_insert_poc"
  on public.vendor_account_rules for insert
  with check (true);

create policy "vendor_account_rules_update_poc"
  on public.vendor_account_rules for update
  using (true)
  with check (true);

create policy "vendor_account_rules_delete_poc"
  on public.vendor_account_rules for delete
  using (true);

grant select, insert, update, delete
  on table public.vendor_account_rules to anon, authenticated;
grant select, insert, update, delete
  on table public.vendor_account_rules to service_role;
