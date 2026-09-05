-- Bank phase 1: get the payment record right.
--
-- Three company settings (the reviewer's decisions, not ours):
--   • already_recorded_window_days — how close in date a payment posted
--     THROUGH THIS APP has to be to count as "already recorded" for a new
--     statement line of the same party and amount. Only our own posts are
--     checked; Zoho is not queried for this.
--   • bank_charge_tolerance — per currency: a receipt short by no more than
--     this is proposed as bank charges rather than a partial payment
--     (default AED 5, USD 13; other currencies → no bank-charge suggestion).
--   • write-off policy — NULL until the company sets its IFRS-based policy;
--     while unset, no write-off is ever suggested. When set: a residual of
--     at most writeoff_max_amount on a document overdue by more than
--     writeoff_after_days is proposed for write-off (never done silently).
--
-- Statement lines gain the reviewer's allocation across several documents,
-- bank charges, a write-off flag, and a reference to an existing Zoho
-- record for "already recorded" links and refunds.

alter table public.company_config
  add column if not exists already_recorded_window_days integer not null default 3,
  add column if not exists bank_charge_tolerance jsonb not null default '{"AED": 5, "USD": 13}'::jsonb,
  add column if not exists writeoff_after_days integer,
  add column if not exists writeoff_max_amount numeric,
  add column if not exists writeoff_policy_note text;

alter table public.bank_statement_lines
  -- [{doc_kind, doc_zoho_id, doc_number, amount_applied}] — sum ≤ amount;
  -- any remainder is an advance (unused) on the party.
  add column if not exists chosen_allocations jsonb,
  add column if not exists chosen_bank_charges numeric,
  add column if not exists chosen_writeoff boolean not null default false,
  -- For already_recorded: the Zoho id we are linking to. For refunds: the
  -- credit note / vendor credit / payment being refunded.
  add column if not exists chosen_ref_kind text,
  add column if not exists chosen_ref_zoho_id text,
  add column if not exists chosen_ref_number text,
  -- A single line may produce two Zoho records (e.g. payment + bank-charge
  -- expense, or partial payment + write-off); keep them all.
  add column if not exists zoho_extra_ids jsonb not null default '[]'::jsonb;

alter table public.bank_statement_lines drop constraint if exists bank_statement_lines_chosen_txn_kind_check;
alter table public.bank_statement_lines add constraint bank_statement_lines_chosen_txn_kind_check
  check (chosen_txn_kind in (
    'customer_payment', 'vendor_payment', 'expense', 'deposit', 'transfer', 'other',
    'already_recorded', 'retainer_receipt',
    'creditnote_refund', 'payment_refund', 'vendorcredit_refund', 'vendorpayment_refund'
  ));
alter table public.bank_statement_lines drop constraint if exists bank_statement_lines_chosen_ref_kind_check;
alter table public.bank_statement_lines add constraint bank_statement_lines_chosen_ref_kind_check
  check (chosen_ref_kind is null or chosen_ref_kind in
    ('customerpayment', 'vendorpayment', 'expense', 'banktransaction', 'creditnote', 'vendorcredit', 'retainerinvoice'));

alter table public.bk_bank_patterns drop constraint if exists bk_bank_patterns_txn_kind_check;
alter table public.bk_bank_patterns add constraint bk_bank_patterns_txn_kind_check
  check (txn_kind in (
    'customer_payment', 'vendor_payment', 'expense', 'deposit', 'transfer', 'other',
    'already_recorded', 'retainer_receipt',
    'creditnote_refund', 'payment_refund', 'vendorcredit_refund', 'vendorpayment_refund'
  ));

-- Which Zoho object a document became (bills | expenses | invoices), so
-- expenses paid through the bank count as "already recorded" for the
-- statement flow. Filled by zoho-push from here on.
alter table public.erp_sync_log add column if not exists external_kind text;

-- The reviewer edits the three policies from the app (POC posture, like
-- the other tables).
create policy "company_config_update_poc" on public.company_config
  for update to anon, authenticated using (true) with check (true);
grant update on table public.company_config to anon, authenticated;
