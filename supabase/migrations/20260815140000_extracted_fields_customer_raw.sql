-- Sales invoices name two parties: the issuer (vendor_raw — us) and the
-- bill-to (the customer). Capture the bill-to so the review screen can
-- auto-match the Zoho customer on the invoice path.
alter table public.extracted_fields
  add column if not exists customer_raw text;

comment on column public.extracted_fields.customer_raw is
  'Bill-to / customer name as printed. Null on purchase bills.';
