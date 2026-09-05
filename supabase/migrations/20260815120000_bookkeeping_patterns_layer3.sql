-- Bookkeeping patterns, layer 3: attachment conventions per party.
-- See docs/BOOKKEEPING_PATTERNS_SPEC.md §3.5.
--
-- Learned from documents[] on historical bills already held in
-- bk_history_raw (no extra Zoho calls). The proposed strictness for the
-- missing_supporting_document check is a bk_check_proposals row of kind
-- 'supporting_document_strictness' — same propose-only lifecycle: the
-- judgment engine reads nothing here until a human enables it.

create table public.bk_attachment_conventions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  party_kind text not null check (party_kind in ('vendor', 'customer')),
  party_zoho_id text not null,
  party_name text not null,
  count_mode integer not null default 0,
  count_mode_share numeric not null default 0,
  attached_share numeric not null default 0,
  multi_share numeric not null default 0,
  types jsonb not null default '{}'::jsonb,
  recurring_name_tokens text[] not null default '{}',
  sample_size integer not null default 0,
  confidence numeric not null default 0,
  proposed_strictness text not null
    check (proposed_strictness in ('strict', 'standard', 'relaxed')),
  rationale text not null,
  computed_at timestamptz not null default now(),
  unique (company_id, party_kind, party_zoho_id)
);

alter table public.bk_attachment_conventions enable row level security;
create policy "bk_attachment_conventions_read_poc"
  on public.bk_attachment_conventions for select to anon, authenticated
  using (true);
grant select on table public.bk_attachment_conventions to anon, authenticated;
grant select, insert, update, delete on table public.bk_attachment_conventions
  to service_role;

-- Widen the check-proposal kinds to include attachment strictness.
alter table public.bk_check_proposals
  drop constraint bk_check_proposals_check_kind_check;
alter table public.bk_check_proposals
  add constraint bk_check_proposals_check_kind_check
  check (
    check_kind in (
      'recurring_twice_in_period',
      'amount_anomaly',
      'expected_missing',
      'supporting_document_strictness'
    )
  );
