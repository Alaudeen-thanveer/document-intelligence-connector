-- Core schema for Document Intelligence Connector (Step 1)
-- Tables: documents, extracted_fields, judgment_results, erp_sync_log

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  file_url text not null,
  status text not null default 'pending',
  uploaded_at timestamptz not null default now()
);

create index documents_status_idx on public.documents (status);

alter table public.documents enable row level security;

-- ---------------------------------------------------------------------------
-- extracted_fields
-- ---------------------------------------------------------------------------
create table public.extracted_fields (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  doc_type text,
  vendor_raw text,
  total_amount numeric,
  invoice_date date,
  confidence_scores jsonb,
  raw_ocr_json jsonb,
  ai_fallback_used boolean not null default false
);

create index extracted_fields_document_id_idx on public.extracted_fields (document_id);

alter table public.extracted_fields enable row level security;

-- ---------------------------------------------------------------------------
-- judgment_results
-- ---------------------------------------------------------------------------
create table public.judgment_results (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  rule_name text not null,
  passed boolean not null,
  notes text,
  reviewed_by text
);

create index judgment_results_document_id_idx on public.judgment_results (document_id);

alter table public.judgment_results enable row level security;

-- ---------------------------------------------------------------------------
-- erp_sync_log
-- ---------------------------------------------------------------------------
create table public.erp_sync_log (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  source_type text not null check (source_type in ('push', 'pull')),
  erp_name text not null,
  external_doc_id text,
  synced_at timestamptz not null default now(),
  judgment_result_id uuid references public.judgment_results (id) on delete set null
);

create index erp_sync_log_document_id_idx on public.erp_sync_log (document_id);

alter table public.erp_sync_log enable row level security;
