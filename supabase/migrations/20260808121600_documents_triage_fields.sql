-- Triage writes doc_type + confidence onto documents (Step 2)
alter table public.documents
  add column if not exists doc_type text,
  add column if not exists confidence numeric;

create index if not exists documents_doc_type_idx on public.documents (doc_type);
