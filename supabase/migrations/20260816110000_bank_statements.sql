-- Bank layers 2–4: statements, their lines, and what happened to each line.
--
-- A statement arrives as a CSV/TSV upload, a PDF (read by the vision
-- model), pasted text, or — once the mailbox is wired — an email body or
-- attachment. It is parsed into dated debit/credit lines against ONE Zoho
-- bank account chosen by the reviewer.
--
-- Each line carries, separately:
--   • suggestion  — what the app proposes (party, account, kind, and if
--                   money in/out matches an open invoice/bill, that doc),
--                   with confidence and the reason. NULL when nothing is
--                   suggestible: the line is simply open.
--   • chosen_*    — what the reviewer confirmed. Only chosen values ever
--                   reach Zoho, and only on an explicit push.
-- Confirmed lines feed bank layer 1 as observations, so the app learns
-- from every decision without any rule being auto-created.

create table public.bank_statements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  bank_account_zoho_id text not null,
  bank_account_name text,
  source text not null check (source in ('upload_csv', 'upload_pdf', 'paste', 'email')),
  file_url text,
  original_name text,
  currency text,
  period_start date,
  period_end date,
  line_count integer not null default 0,
  skipped_rows jsonb not null default '[]'::jsonb,
  parse_info jsonb not null default '{}'::jsonb,
  status text not null default 'in_review'
    check (status in ('in_review', 'done')),
  created_by text,
  created_at timestamptz not null default now()
);
create index bank_statements_company_idx on public.bank_statements (company_id, created_at desc);

create table public.bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references public.bank_statements (id) on delete cascade,
  company_id uuid not null references public.company_config (company_id),
  line_no integer not null,
  txn_date date not null,
  value_date date,
  description text not null,
  reference text,
  side text not null check (side in ('debit', 'credit')),
  amount numeric not null check (amount > 0),
  balance numeric,

  -- What the app proposes. Shape (all optional):
  -- { txn_kind, party_kind, party_zoho_id, party_name, account_id, account_name,
  --   doc_kind, doc_zoho_id, doc_number, doc_balance, confidence, source, reason }
  -- source ∈ 'learned' | 'accepted_rule' | 'open_document' | 'party_name'
  suggestion jsonb,

  -- What the reviewer confirmed. Empty until they act.
  status text not null default 'open'
    check (status in ('open', 'confirmed', 'posted', 'skipped', 'failed')),
  chosen_txn_kind text check (chosen_txn_kind in
    ('customer_payment', 'vendor_payment', 'expense', 'deposit', 'transfer', 'other')),
  chosen_party_kind text check (chosen_party_kind in ('vendor', 'customer')),
  chosen_party_zoho_id text,
  chosen_party_name text,
  chosen_account_id text,
  chosen_account_name text,
  chosen_doc_kind text check (chosen_doc_kind in ('invoice', 'bill')),
  chosen_doc_zoho_id text,
  chosen_doc_number text,
  -- Whether the reviewer took the suggestion as-is, changed it, or filled a
  -- blank — the disagreement signal for later learning.
  decision text check (decision in ('accepted_suggestion', 'changed_suggestion', 'filled_blank')),
  decided_by text,
  decided_at timestamptz,

  -- Zoho outcome.
  zoho_txn_id text,
  zoho_payload jsonb,
  error text,
  posted_at timestamptz,
  unique (statement_id, line_no)
);
create index bank_statement_lines_company_status_idx
  on public.bank_statement_lines (company_id, status);
create index bank_statement_lines_statement_idx
  on public.bank_statement_lines (statement_id, line_no);

alter table public.bank_statements enable row level security;
alter table public.bank_statement_lines enable row level security;
create policy "bank_statements_poc" on public.bank_statements
  for all to anon, authenticated using (true) with check (true);
create policy "bank_statement_lines_poc" on public.bank_statement_lines
  for all to anon, authenticated using (true) with check (true);
grant select, insert, update on table public.bank_statements to anon, authenticated;
grant select, insert, update on table public.bank_statement_lines to anon, authenticated;
grant select, insert, update, delete on table public.bank_statements to service_role;
grant select, insert, update, delete on table public.bank_statement_lines to service_role;

-- Realtime for the review screen (documents already publish this way).
alter publication supabase_realtime add table public.bank_statement_lines;
