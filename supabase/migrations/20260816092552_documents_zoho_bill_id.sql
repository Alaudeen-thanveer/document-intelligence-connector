-- Store the Zoho Books bill/invoice/expense id on the document after a
-- successful zoho-approve push. Status 'sync_failed' is also used by that
-- function; documents.status is unconstrained text.

alter table public.documents
  add column if not exists zoho_bill_id text;

comment on column public.documents.zoho_bill_id is
  'Zoho Books bill_id (or invoice/expense id) after a successful sync.';
