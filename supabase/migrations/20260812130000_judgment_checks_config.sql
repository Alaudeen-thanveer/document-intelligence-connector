-- Judgment check config (hardcoded checks step) + fields those checks need.
-- company_id already on company_config / documents.

alter table public.company_config
  add column if not exists duplicate_check_days integer not null default 3
    check (duplicate_check_days >= 0),
  add column if not exists amount_requires_po_threshold numeric not null default 5000
    check (amount_requires_po_threshold >= 0);

-- Whether a supporting document was attached / linked for this invoice.
alter table public.documents
  add column if not exists has_supporting_document boolean not null default false;

-- Optional PO reference extracted or entered for the invoice.
alter table public.extracted_fields
  add column if not exists po_number text;

comment on column public.company_config.duplicate_check_days is
  'Duplicate check window: same vendor+amount+date within this many days (default 3).';
comment on column public.company_config.amount_requires_po_threshold is
  'Invoices above this amount require a PO number.';
comment on column public.documents.has_supporting_document is
  'True when a supporting document is present for judgment check 2.';
comment on column public.extracted_fields.po_number is
  'Purchase order number; required when amount exceeds company threshold.';
