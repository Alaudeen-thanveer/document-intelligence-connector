-- Roadmap item 16: fixed assets + prepayment/accrual schedules.
--
-- • bk_asset_proposals — when an approved bill has a line coded to a
--   fixed-asset account, the app proposes creating the asset record in
--   Zoho's Fixed Assets module. A human confirms (or dismisses); the
--   created asset's Zoho id is remembered so nothing is proposed twice.
-- • bk_schedules — prepayments (a bill line on a "Prepaid …" account) and
--   accruals (added by hand): N monthly entries spreading the amount from
--   the balance-sheet account to the P&L account. Each due month becomes a
--   journal proposal (kind 'schedule') on the existing confirm-to-post
--   machinery — same validation, same period-lock guard, never twice.

create table if not exists public.bk_asset_proposals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  document_id uuid references public.documents (id) on delete set null,
  bill_zoho_id text not null,
  bill_number text,
  line_description text not null,
  amount numeric not null,
  asset_account_id text not null,
  asset_account_name text,
  purchase_date date,
  status text not null default 'proposed' check (status in ('proposed', 'created', 'dismissed')),
  zoho_asset_id text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, bill_zoho_id, line_description)
);
alter table public.bk_asset_proposals enable row level security;
create policy "bk_asset_proposals_select_company" on public.bk_asset_proposals for select to authenticated using (company_id = public.current_company_id());
create policy "bk_asset_proposals_update_company" on public.bk_asset_proposals for update to authenticated using (company_id = public.current_company_id()) with check (company_id = public.current_company_id());
revoke all on table public.bk_asset_proposals from anon, public;
grant select, update on table public.bk_asset_proposals to authenticated;
grant select, insert, update, delete on table public.bk_asset_proposals to service_role;

create table if not exists public.bk_schedules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  kind text not null check (kind in ('prepayment', 'accrual')),
  label text not null,
  source_kind text not null default 'manual' check (source_kind in ('bill', 'manual')),
  source_zoho_id text,
  source_number text,
  -- Balance-sheet side (prepaid asset / accrued liability) and P&L side.
  bs_account_id text not null,
  bs_account_name text,
  pl_account_id text not null,
  pl_account_name text,
  total numeric not null,
  months integer not null,
  start_period text not null, -- yyyy-mm
  status text not null default 'proposed' check (status in ('proposed', 'active', 'done', 'dismissed')),
  created_by text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.bk_schedules enable row level security;
create policy "bk_schedules_select_company" on public.bk_schedules for select to authenticated using (company_id = public.current_company_id());
create policy "bk_schedules_update_company" on public.bk_schedules for update to authenticated using (company_id = public.current_company_id()) with check (company_id = public.current_company_id());
revoke all on table public.bk_schedules from anon, public;
grant select, update on table public.bk_schedules to authenticated;
grant select, insert, update, delete on table public.bk_schedules to service_role;

alter table public.bk_journal_proposals drop constraint if exists bk_journal_proposals_kind_check;
alter table public.bk_journal_proposals add constraint bk_journal_proposals_kind_check
  check (kind in ('pattern', 'ct_provision', 'schedule'));
alter table public.bk_journal_proposals
  add column if not exists schedule_id uuid references public.bk_schedules (id) on delete cascade;
create unique index if not exists bk_journal_proposals_schedule_period_idx
  on public.bk_journal_proposals (schedule_id, period)
  where schedule_id is not null;

-- The one-per-kind-per-period index (from the corporate-tax migration) must
-- NOT cover schedule rows — several schedules can each have an entry in the
-- same period. Their uniqueness is per (schedule_id, period) above.
drop index if exists public.bk_journal_proposals_kind_period_idx;
create unique index bk_journal_proposals_kind_period_idx
  on public.bk_journal_proposals (company_id, kind, period)
  where pattern_id is null and schedule_id is null;
