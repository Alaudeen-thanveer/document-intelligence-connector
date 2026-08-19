-- Roadmap items 3–7: bank rules, reconciliation, journal proposals,
-- purchase-order three-way match.
--
-- • zoho_entities gains two read-only kinds: the org's own BANK RULES
--   (explicit habits, used as high-weight evidence and to avoid proposing a
--   rule that already exists) and open PURCHASE ORDERS with their lines
--   (the "what was ordered" side of the match).
-- • bk_bank_patterns remembers when a learned pattern was proposed as a Zoho
--   bank rule (always in "recognize" = suggest-only mode).
-- • company_config gains the PO variance tolerances (percent and amount)
--   that decide whether a bill "matches" its PO.
-- • bk_journal_patterns remembers the journal proposed/posted per period so
--   month-end can show the proposal and never double-post.

alter table public.zoho_entities drop constraint if exists zoho_entities_kind_check;
alter table public.zoho_entities add constraint zoho_entities_kind_check
  check (kind in ('account', 'vendor', 'customer', 'reporting_tag', 'currency', 'project', 'tax',
                  'bank_account', 'payment_term', 'item', 'user', 'bank_rule', 'purchase_order'));

alter table public.bk_bank_patterns
  add column if not exists zoho_rule_id text,
  add column if not exists zoho_rule_created_at timestamptz,
  add column if not exists zoho_rule_created_by text;

alter table public.company_config
  add column if not exists po_variance_pct numeric not null default 2,
  add column if not exists po_variance_amount numeric not null default 10;

-- Journals proposed from enabled patterns, per period.
create table if not exists public.bk_journal_proposals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  pattern_id uuid not null references public.bk_journal_patterns (id) on delete cascade,
  period text not null, -- yyyy-mm
  journal_date date not null,
  reference_number text,
  notes text,
  -- [{account_id, account_name, side: 'D'|'C', amount}]
  lines jsonb not null,
  total numeric not null,
  status text not null default 'proposed' check (status in ('proposed', 'posted', 'dismissed')),
  zoho_journal_id text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (pattern_id, period)
);
alter table public.bk_journal_proposals enable row level security;
create policy "bk_journal_proposals_select_company" on public.bk_journal_proposals for select to authenticated using (company_id = public.current_company_id());
create policy "bk_journal_proposals_update_company" on public.bk_journal_proposals for update to authenticated using (company_id = public.current_company_id()) with check (company_id = public.current_company_id());
revoke all on table public.bk_journal_proposals from anon, public;
grant select, update on table public.bk_journal_proposals to authenticated;
grant select, insert, update, delete on table public.bk_journal_proposals to service_role;
