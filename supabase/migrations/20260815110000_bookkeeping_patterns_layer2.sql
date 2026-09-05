-- Bookkeeping patterns, layer 2: recurrence cadence per vendor and the
-- per-vendor judgment checks that cadence justifies — as PROPOSALS.
-- See docs/BOOKKEEPING_PATTERNS_SPEC.md §3.2.
--
-- The judgment engine does NOT read bk_check_proposals. A proposed check
-- has no effect on any document until a human enables it (status →
-- 'enabled'), and only enabled rows are ever consulted.

create table public.bk_rhythms (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  party_kind text not null check (party_kind in ('vendor', 'customer')),
  party_zoho_id text not null,
  party_name text not null,
  cadence text not null
    check (cadence in ('fixed_recurring', 'variable_recurring', 'irregular', 'insufficient')),
  months_observed integer not null default 0,
  months_spanned integer not null default 0,
  monthly_coverage numeric not null default 0,
  expected_day_min integer,
  expected_day_max integer,
  amount_median numeric,
  amount_p10 numeric,
  amount_p90 numeric,
  amount_cv numeric,
  sample_size integer not null default 0,
  last_seen date,
  next_expected date,
  confidence numeric not null default 0,
  computed_at timestamptz not null default now(),
  unique (company_id, party_kind, party_zoho_id)
);

alter table public.bk_rhythms enable row level security;
create policy "bk_rhythms_read_poc"
  on public.bk_rhythms for select to anon, authenticated using (true);
grant select on table public.bk_rhythms to anon, authenticated;
grant select, insert, update, delete on table public.bk_rhythms to service_role;

create table public.bk_check_proposals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  party_kind text not null check (party_kind in ('vendor', 'customer')),
  party_zoho_id text not null,
  party_name text not null,
  check_kind text not null
    check (check_kind in ('recurring_twice_in_period', 'amount_anomaly', 'expected_missing')),
  rationale text not null,
  params jsonb not null default '{}'::jsonb,
  -- Only the UI moves proposed → enabled/dismissed. Recompute never
  -- overwrites a human decision.
  status text not null default 'proposed'
    check (status in ('proposed', 'enabled', 'dismissed', 'stale')),
  decided_by text,
  decided_at timestamptz,
  computed_at timestamptz not null default now(),
  unique (company_id, party_kind, party_zoho_id, check_kind)
);

create index bk_check_proposals_company_status_idx
  on public.bk_check_proposals (company_id, status);

alter table public.bk_check_proposals enable row level security;
create policy "bk_check_proposals_poc"
  on public.bk_check_proposals for all to anon, authenticated
  using (true) with check (true);
grant select, update on table public.bk_check_proposals to anon, authenticated;
grant select, insert, update, delete on table public.bk_check_proposals
  to service_role;
