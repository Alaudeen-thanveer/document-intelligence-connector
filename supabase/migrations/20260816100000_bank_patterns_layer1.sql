-- Bank layer 1: what a statement description usually means.
--
-- Learned from every categorised bank transaction in Zoho Books, every
-- customer/vendor payment (their description + reference), and — once the
-- bank statement flow exists — every line a reviewer confirms in this app.
-- A pattern is (statement fingerprint, side) → the party, account and
-- transaction kind the bookkeeper usually chose, with evidence.
--
-- Patterns drive per-line SUGGESTIONS only. A suggestion is never posted
-- until a reviewer confirms the line, and nothing is suggested below the
-- confidence gate — the line is simply left open.

-- Raw bank transactions join the history store.
alter table public.bk_history_raw
  drop constraint bk_history_raw_doc_kind_check;
alter table public.bk_history_raw
  add constraint bk_history_raw_doc_kind_check
  check (doc_kind in ('bill', 'invoice', 'expense', 'journal',
                      'vendorpayment', 'customerpayment', 'banktransaction'));

alter table public.bk_learn_runs
  add column if not exists bank_transactions_fetched integer not null default 0;

create table public.bk_bank_patterns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  -- Sorted salient tokens of the statement description, space-joined.
  fingerprint text not null,
  tokens text[] not null default '{}',
  -- debit = money out, credit = money in. Same words on opposite sides are
  -- different habits (a payment vs a refund), so side is part of the key.
  side text not null check (side in ('debit', 'credit')),
  txn_kind text not null check (txn_kind in
    ('customer_payment', 'vendor_payment', 'expense', 'deposit', 'transfer', 'other')),
  party_kind text check (party_kind in ('vendor', 'customer')),
  party_zoho_id text,
  party_name text,
  account_id text,
  account_name text,
  sample_size integer not null default 0,
  share numeric not null default 0,
  amount_median numeric,
  amount_p10 numeric,
  amount_p90 numeric,
  first_seen date,
  last_seen date,
  -- Up to three raw descriptions it learned from, for the reviewer.
  examples jsonb not null default '[]'::jsonb,
  confidence numeric not null default 0,
  -- proposed → suggestions carry "learned"; accepted → suggestions carry
  -- "your rule" and may join a clear lane later; dismissed → never suggested.
  suggestion_status text not null default 'proposed'
    check (suggestion_status in ('proposed', 'accepted', 'dismissed')),
  decided_by text,
  decided_at timestamptz,
  computed_at timestamptz not null default now(),
  unique (company_id, fingerprint, side)
);
create index bk_bank_patterns_company_side_idx
  on public.bk_bank_patterns (company_id, side);

alter table public.bk_bank_patterns enable row level security;
create policy "bk_bank_patterns_poc"
  on public.bk_bank_patterns for all to anon, authenticated
  using (true) with check (true);
grant select, update on table public.bk_bank_patterns to anon, authenticated;
grant select, insert, update, delete on table public.bk_bank_patterns to service_role;
