-- ---------------------------------------------------------------------------
-- The row grid needs a document's read values beside the document itself.
--
-- documents carries eight columns; the grid shows about seventeen, and the
-- rest — vendor, amount, currency, invoice number, purchase order — live in
-- extracted_fields. This adds the view that joins them, the human "ready to
-- post" signal, and a defensible answer to "which extraction is current".
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- ready: what a person decided, kept apart from what the pipeline did
-- ---------------------------------------------------------------------------
alter table public.documents
  add column if not exists ready_at timestamptz,
  add column if not exists ready_by text;

comment on column public.documents.ready_at is
  'When a reviewer ticked this document ready to post. documents.status records what the pipeline did to a document; this records what a human decided about it, which is a different question.';
comment on column public.documents.ready_by is
  'Who ticked it. Free text, same convention as judgment_results.reviewed_by.';

create index if not exists documents_ready_at_idx
  on public.documents (company_id, ready_at desc)
  where ready_at is not null;

-- ---------------------------------------------------------------------------
-- which extraction is the current one
--
-- Re-extraction inserts another extracted_fields row, and every reader —
-- this app, judgment, zoho-approve — asked for "the latest" with
-- `order by id desc limit 1`. id is a random uuid, so that ordering is
-- arbitrary: after a re-extract, the row you get is whichever uuid happened
-- to sort highest. They at least all agreed with each other, so the fault
-- was invisible; building the grid on top of it would have made it real.
--
-- created_at gives the question an answer. Backfilled from the document's
-- own uploaded_at so existing rows keep a sane order, with id as the
-- tiebreak, which is exactly what today's behaviour was.
-- ---------------------------------------------------------------------------
alter table public.extracted_fields
  add column if not exists created_at timestamptz;

update public.extracted_fields e
   set created_at = d.uploaded_at
  from public.documents d
 where d.id = e.document_id
   and e.created_at is null;

update public.extracted_fields
   set created_at = now()
 where created_at is null;

alter table public.extracted_fields
  alter column created_at set default now(),
  alter column created_at set not null;

comment on column public.extracted_fields.created_at is
  'When this extraction was written. The current extraction for a document is the one with the highest (created_at, id).';

create index if not exists extracted_fields_document_current_idx
  on public.extracted_fields (document_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- the grid's row
--
-- security_invoker so the view inherits the RLS on documents,
-- extracted_fields and judgment_results rather than bypassing it — the whole
-- schema is company-scoped and a view without it leaks across companies.
--
-- Realtime stays on the base documents table: Postgres emits no
-- postgres_changes for a view.
-- ---------------------------------------------------------------------------
create or replace view public.documents_grid
  with (security_invoker = true)
as
  select
    d.id,
    d.company_id,
    d.source,
    d.file_url,
    d.status,
    d.uploaded_at,
    d.doc_type,
    d.confidence,
    d.zoho_bill_id,
    d.has_supporting_document,
    d.ready_at,
    d.ready_by,
    e.id            as extracted_fields_id,
    e.vendor_raw,
    e.customer_raw,
    e.invoice_number,
    e.invoice_date,
    e.due_date,
    e.total_amount,
    e.tax_amount,
    e.currency,
    e.po_number,
    e.ai_fallback_used,
    coalesce(j.checks_total, 0)  as checks_total,
    coalesce(j.checks_passed, 0) as checks_passed
  from public.documents d
  left join lateral (
    select ef.*
      from public.extracted_fields ef
     where ef.document_id = d.id
     order by ef.created_at desc, ef.id desc
     limit 1
  ) e on true
  left join lateral (
    select
      count(*)                          as checks_total,
      count(*) filter (where jr.passed) as checks_passed
      from public.judgment_results jr
     where jr.document_id = d.id
  ) j on true;

comment on view public.documents_grid is
  'One row per document with its current extraction and its check tally, for the review grid. security_invoker, so RLS on the underlying tables applies.';

grant select on public.documents_grid to authenticated, service_role;
