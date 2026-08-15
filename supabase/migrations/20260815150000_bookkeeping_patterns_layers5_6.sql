-- Bookkeeping patterns, layers 5 + 6.
--   5: manual journal patterns beyond Zoho's recurring definitions
--   6: timing / payment behaviour per party
-- Both are PROPOSALS. Journal patterns become month-end nudges only once a
-- human enables them; timing profiles surface as evidence and (when
-- enabled) as "later than usual" month-end nudges.

-- Raw payments join the history store.
alter table public.bk_history_raw
  drop constraint bk_history_raw_doc_kind_check;
alter table public.bk_history_raw
  add constraint bk_history_raw_doc_kind_check
  check (doc_kind in ('bill', 'invoice', 'expense', 'journal',
                      'vendorpayment', 'customerpayment'));

alter table public.bk_learn_runs
  add column if not exists payments_fetched integer not null default 0;

-- Layer 6: timing profile per party.
create table public.bk_timing_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  party_kind text not null check (party_kind in ('vendor', 'customer')),
  party_zoho_id text not null,
  party_name text not null,
  entry_lag_median numeric,
  entry_lag_p90 numeric,
  pay_lag_median numeric,
  pay_lag_p10 numeric,
  pay_lag_p90 numeric,
  terms_days_mode integer,
  pays_vs_terms_days integer,
  early_share numeric,
  on_time_share numeric,
  late_share numeric,
  payment_mode_mode text,
  payment_account_id text,
  payment_account_name text,
  sample_size integer not null default 0,
  paid_sample_size integer not null default 0,
  confidence numeric not null default 0,
  computed_at timestamptz not null default now(),
  unique (company_id, party_kind, party_zoho_id)
);
alter table public.bk_timing_profiles enable row level security;
create policy "bk_timing_profiles_read_poc"
  on public.bk_timing_profiles for select to anon, authenticated using (true);
grant select on table public.bk_timing_profiles to anon, authenticated;
grant select, insert, update, delete on table public.bk_timing_profiles to service_role;

-- Layer 5: repeating manual journals (undeclared recurring journals).
create table public.bk_journal_patterns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  fingerprint text not null,
  label text not null,
  accounts jsonb not null default '[]'::jsonb,
  cadence text not null,
  monthly_coverage numeric not null default 0,
  expected_day_min integer,
  expected_day_max integer,
  amount_median numeric,
  amount_cv numeric,
  sample_size integer not null default 0,
  first_seen date,
  last_seen date,
  next_expected date,
  confidence numeric not null default 0,
  recurring_note text,
  example_journal_ids text[] not null default '{}',
  -- Only the UI moves proposed → enabled/dismissed. Recompute preserves it.
  status text not null default 'proposed'
    check (status in ('proposed', 'enabled', 'dismissed', 'stale')),
  decided_by text,
  decided_at timestamptz,
  computed_at timestamptz not null default now(),
  unique (company_id, fingerprint)
);
alter table public.bk_journal_patterns enable row level security;
create policy "bk_journal_patterns_poc"
  on public.bk_journal_patterns for all to anon, authenticated
  using (true) with check (true);
grant select, update on table public.bk_journal_patterns to anon, authenticated;
grant select, insert, update, delete on table public.bk_journal_patterns to service_role;

-- Layer 6 also proposes a per-party month-end check: "open document is
-- later than this party usually pays". Reuse bk_check_proposals.
alter table public.bk_check_proposals
  drop constraint bk_check_proposals_check_kind_check;
alter table public.bk_check_proposals
  add constraint bk_check_proposals_check_kind_check
  check (
    check_kind in (
      'recurring_twice_in_period',
      'amount_anomaly',
      'expected_missing',
      'supporting_document_strictness',
      'later_than_usual'
    )
  );
