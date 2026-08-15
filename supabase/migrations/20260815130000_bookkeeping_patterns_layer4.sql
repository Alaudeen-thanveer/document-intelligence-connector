-- Bookkeeping patterns, layer 4: reporting tags + projects.
--
-- Learned per party (bills, invoices, expenses) and per account (journals);
-- stored as PROPOSALS. Prefill at review time happens only for accepted
-- rows. Also carries tags/project on extracted line items so the push
-- can send them to Zoho.

-- History pull now also holds expenses and journals.
alter table public.bk_history_raw
  drop constraint bk_history_raw_doc_kind_check;
alter table public.bk_history_raw
  add constraint bk_history_raw_doc_kind_check
  check (doc_kind in ('bill', 'invoice', 'expense', 'journal'));

alter table public.bk_learn_runs
  add column if not exists expenses_fetched integer not null default 0,
  add column if not exists journals_fetched integer not null default 0;

-- Per party: dominant option per reporting tag.
create table public.bk_party_tag_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  party_kind text not null check (party_kind in ('vendor', 'customer')),
  party_zoho_id text not null,
  party_name text not null,
  tag_id text not null,
  tag_name text,
  option_id text not null,
  option_name text,
  share numeric not null default 0,
  lines integer not null default 0,
  confidence numeric not null default 0,
  suggestion_status text not null default 'proposed'
    check (suggestion_status in ('proposed', 'accepted', 'dismissed', 'stale')),
  decided_by text,
  decided_at timestamptz,
  computed_at timestamptz not null default now(),
  unique (company_id, party_kind, party_zoho_id, tag_id)
);
alter table public.bk_party_tag_profiles enable row level security;
create policy "bk_party_tag_profiles_poc"
  on public.bk_party_tag_profiles for all to anon, authenticated
  using (true) with check (true);
grant select, update on table public.bk_party_tag_profiles to anon, authenticated;
grant select, insert, update, delete on table public.bk_party_tag_profiles to service_role;

-- Per party: dominant project.
create table public.bk_party_project_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  party_kind text not null check (party_kind in ('vendor', 'customer')),
  party_zoho_id text not null,
  party_name text not null,
  project_id text not null,
  project_name text,
  share numeric not null default 0,
  lines integer not null default 0,
  confidence numeric not null default 0,
  suggestion_status text not null default 'proposed'
    check (suggestion_status in ('proposed', 'accepted', 'dismissed', 'stale')),
  decided_by text,
  decided_at timestamptz,
  computed_at timestamptz not null default now(),
  unique (company_id, party_kind, party_zoho_id)
);
alter table public.bk_party_project_profiles enable row level security;
create policy "bk_party_project_profiles_poc"
  on public.bk_party_project_profiles for all to anon, authenticated
  using (true) with check (true);
grant select, update on table public.bk_party_project_profiles to anon, authenticated;
grant select, insert, update, delete on table public.bk_party_project_profiles to service_role;

-- Journals have no party: tag usage learned per ACCOUNT.
create table public.bk_account_tag_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  account_id text not null,
  account_name text,
  tag_id text not null,
  tag_name text,
  option_id text not null,
  option_name text,
  share numeric not null default 0,
  lines integer not null default 0,
  confidence numeric not null default 0,
  suggestion_status text not null default 'proposed'
    check (suggestion_status in ('proposed', 'accepted', 'dismissed', 'stale')),
  decided_by text,
  decided_at timestamptz,
  computed_at timestamptz not null default now(),
  unique (company_id, account_id, tag_id)
);
alter table public.bk_account_tag_profiles enable row level security;
create policy "bk_account_tag_profiles_poc"
  on public.bk_account_tag_profiles for all to anon, authenticated
  using (true) with check (true);
grant select, update on table public.bk_account_tag_profiles to anon, authenticated;
grant select, insert, update, delete on table public.bk_account_tag_profiles to service_role;

-- Line items carry tags + project so the push can send them to Zoho.
alter table public.extracted_line_items
  add column if not exists project_zoho_id text,
  -- [{tag_id, tag_option_id}]
  add column if not exists reporting_tags jsonb not null default '[]'::jsonb;
