-- Bookkeeping patterns, layer 1: party → account profiles learned from
-- Zoho history. See docs/BOOKKEEPING_PATTERNS_SPEC.md.
--
-- PROPOSE, DON'T IMPOSE. The learner writes only to these tables. It never
-- writes vendor_account_rules / customer_account_rules, never writes Zoho,
-- never changes a document. A proposal becomes a real rule only when a
-- human clicks Accept in the Rules screen — that UI action is the sole
-- path from bk_party_profiles to the rules tables.

create table public.bk_party_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  party_kind text not null check (party_kind in ('vendor', 'customer')),
  party_zoho_id text not null,
  party_name text not null,

  -- Dominant GL account across this party's historical lines.
  dominant_account_id text,
  dominant_account_name text,
  account_share numeric,                 -- 0..1 share of lines on the dominant account
  account_split jsonb not null default '[]'::jsonb,
                                          -- [{account_id, account_name, lines, share}]
  -- Header-level habits (mode across historical documents).
  tax_treatment text,
  currency text,
  payment_terms_id text,
  po_usually_present boolean,

  -- Amount profile (document totals).
  amount_median numeric,
  amount_p10 numeric,
  amount_p90 numeric,

  -- Evidence.
  sample_size integer not null default 0, -- historical documents seen
  line_sample_size integer not null default 0,
  confidence numeric not null default 0,  -- 0..1, see learner
  first_seen date,
  last_seen date,
  computed_at timestamptz not null default now(),

  -- Proposal lifecycle. Only the UI moves proposed → accepted/dismissed.
  suggestion_status text not null default 'proposed'
    check (suggestion_status in ('proposed', 'accepted', 'dismissed', 'stale')),
  decided_by text,
  decided_at timestamptz,

  unique (company_id, party_kind, party_zoho_id)
);

create index bk_party_profiles_company_status_idx
  on public.bk_party_profiles (company_id, suggestion_status);

alter table public.bk_party_profiles enable row level security;

-- Dashboard reads proposals and records the human decision; the learner
-- (service role) computes and refreshes profiles.
create policy "bk_party_profiles_poc"
  on public.bk_party_profiles for all
  to anon, authenticated
  using (true)
  with check (true);

grant select, update on table public.bk_party_profiles to anon, authenticated;
grant select, insert, update, delete on table public.bk_party_profiles
  to service_role;

-- Every suggestion shown and what the reviewer did with it. Overrides are
-- the most valuable signal: the convention changed, or the suggestion was
-- wrong.
create table public.bk_suggestion_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  document_id uuid references public.documents (id) on delete set null,
  party_kind text,
  party_zoho_id text,
  field text not null,                    -- e.g. account_id, tax_treatment
  suggested_value text,
  suggested_confidence numeric,
  outcome text not null
    check (outcome in ('accepted', 'overridden', 'dismissed', 'shown')),
  final_value text,
  decided_by text,
  created_at timestamptz not null default now()
);

create index bk_suggestion_log_company_idx
  on public.bk_suggestion_log (company_id, created_at desc);

alter table public.bk_suggestion_log enable row level security;

create policy "bk_suggestion_log_poc"
  on public.bk_suggestion_log for all
  to anon, authenticated
  using (true)
  with check (true);

grant select, insert on table public.bk_suggestion_log to anon, authenticated;
grant select, insert, update, delete on table public.bk_suggestion_log
  to service_role;

-- Raw historical pulls, so re-analysis never re-fetches from Zoho.
create table public.bk_history_raw (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  doc_kind text not null check (doc_kind in ('bill', 'invoice')),
  zoho_id text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  unique (company_id, doc_kind, zoho_id)
);

alter table public.bk_history_raw enable row level security;
grant select, insert, update, delete on table public.bk_history_raw
  to service_role;

-- Onboarding job progress, so a long pull is resumable.
create table public.bk_learn_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  months_back integer not null default 24,
  bills_fetched integer not null default 0,
  invoices_fetched integer not null default 0,
  profiles_written integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.bk_learn_runs enable row level security;
create policy "bk_learn_runs_read_poc"
  on public.bk_learn_runs for select
  to anon, authenticated
  using (true);
grant select on table public.bk_learn_runs to anon, authenticated;
grant select, insert, update, delete on table public.bk_learn_runs
  to service_role;
