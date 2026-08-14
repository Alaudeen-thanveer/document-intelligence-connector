-- Multi-line-item capture + remaining bill/invoice header fields.
-- Each invoice line is stored and pushed to Zoho individually, with its
-- own GL account (and tax) — matching how Zoho Books itself models bills.

alter table public.extracted_fields
  add column if not exists invoice_number text,
  add column if not exists due_date date;

comment on column public.extracted_fields.invoice_number is
  'The document''s own number as printed (becomes Zoho bill_number).';
comment on column public.extracted_fields.due_date is
  'Payment due date as printed, if any.';

create table public.extracted_line_items (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  extracted_fields_id uuid not null
    references public.extracted_fields (id) on delete cascade,
  line_no integer not null default 1,
  description text,
  quantity numeric not null default 1,
  -- Unit price; amount is the printed line total (quantity × rate).
  rate numeric,
  amount numeric,
  -- Per-line GL account chosen in review (Zoho account id).
  account_zoho_id text,
  -- Optional per-line tax override (Zoho tax id).
  tax_zoho_id text,
  source text not null default 'ocr' check (source in ('ocr', 'gemini', 'manual'))
);

create index extracted_line_items_document_id_idx
  on public.extracted_line_items (document_id);
create index extracted_line_items_extracted_fields_id_idx
  on public.extracted_line_items (extracted_fields_id);

alter table public.extracted_line_items enable row level security;

-- POC-open like the other review tables; tighten with reviewer auth later.
create policy "extracted_line_items_poc"
  on public.extracted_line_items for all
  to anon, authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on table public.extracted_line_items
  to anon, authenticated, service_role;
