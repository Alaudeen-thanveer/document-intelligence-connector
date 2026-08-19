-- Roadmap items 8-12: VAT return (Form 201) pre-filing review, UAE
-- e-invoicing field readiness, period lock, multi-currency revaluation,
-- corporate tax provision.
--
-- • company_config gains the VAT period shape (months per period + which
--   month a period ends on + filing window), the app-side period lock
--   (Zoho exposes no transaction-locking API on the .ae DC — verified),
--   and the corporate-tax provision settings (rate, small-business
--   threshold, the two accounts the provision journal posts to).
-- • bk_journal_proposals learns a `kind` so schedule-driven proposals
--   (corporate tax) can live beside pattern-driven ones; pattern_id
--   becomes nullable for those.

alter table public.company_config
  -- VAT: quarterly by default, quarters ending Mar/Jun/Sep/Dec, filing due
  -- 28 days after the period ends (FTA standard).
  add column if not exists vat_period_months integer not null default 3,
  add column if not exists vat_period_anchor_month integer not null default 3,
  add column if not exists vat_filing_due_days integer not null default 28,
  -- Period lock: nothing may post into the books on or before this date.
  add column if not exists locked_until date,
  -- Corporate tax provision (UAE: 9% above AED 375,000; both accounts must
  -- be chosen by the company before anything is proposed).
  add column if not exists ct_rate numeric not null default 9,
  add column if not exists ct_threshold numeric not null default 375000,
  add column if not exists ct_expense_account_id text,
  add column if not exists ct_payable_account_id text;

alter table public.bk_journal_proposals
  alter column pattern_id drop not null,
  add column if not exists kind text not null default 'pattern'
    check (kind in ('pattern', 'ct_provision'));

-- One schedule-driven proposal per kind per period (pattern rows keep
-- their existing unique (pattern_id, period)).
create unique index if not exists bk_journal_proposals_kind_period_idx
  on public.bk_journal_proposals (company_id, kind, period)
  where pattern_id is null;
