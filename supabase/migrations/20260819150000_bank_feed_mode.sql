-- Bank feed mode: work on Zoho's OWN uncategorised bank lines.
--
-- When a bank feed (or a statement import) exists in Zoho Books, the lines
-- already live there as "uncategorized transactions". Feed mode pulls
-- them, runs the same suggestion engine, and acts with Zoho's own verbs —
-- match (link to a record already in the books), categorize (create the
-- record from the line), exclude. Zoho keeps the statement and the
-- reconciliation; there is exactly one copy of every line.
--
-- A statement pulled this way has source 'zoho_feed'; each of its lines
-- carries the Zoho uncategorised transaction id and, when Zoho proposed
-- matches, those candidates. 'exclude' joins the decisions a reviewer can
-- make (and the learner can learn).

alter table public.bank_statements drop constraint if exists bank_statements_source_check;
alter table public.bank_statements add constraint bank_statements_source_check
  check (source in ('upload_csv', 'upload_pdf', 'paste', 'email', 'zoho_feed'));

alter table public.bank_statement_lines
  add column if not exists zoho_uncategorized_id text,
  add column if not exists zoho_payee text,
  -- [{transaction_id, transaction_type, date, amount, contact_name, reference_number}]
  add column if not exists zoho_match_candidates jsonb;
create index if not exists bank_statement_lines_zoho_uncat_idx
  on public.bank_statement_lines (company_id, zoho_uncategorized_id)
  where zoho_uncategorized_id is not null;

alter table public.bank_statement_lines drop constraint if exists bank_statement_lines_chosen_txn_kind_check;
alter table public.bank_statement_lines add constraint bank_statement_lines_chosen_txn_kind_check
  check (chosen_txn_kind in (
    'customer_payment', 'vendor_payment', 'expense', 'deposit', 'transfer', 'other',
    'already_recorded', 'retainer_receipt',
    'creditnote_refund', 'payment_refund', 'vendorcredit_refund', 'vendorpayment_refund',
    'exclude'
  ));
alter table public.bk_bank_patterns drop constraint if exists bk_bank_patterns_txn_kind_check;
alter table public.bk_bank_patterns add constraint bk_bank_patterns_txn_kind_check
  check (txn_kind in (
    'customer_payment', 'vendor_payment', 'expense', 'deposit', 'transfer', 'other',
    'already_recorded', 'retainer_receipt',
    'creditnote_refund', 'payment_refund', 'vendorcredit_refund', 'vendorpayment_refund',
    'exclude'
  ));
