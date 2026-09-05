-- Invoices carry a currency and often a VAT amount; capture both at
-- extraction so the push stage can set the right currency and tax fields
-- on the Zoho bill/invoice instead of lumping VAT into the total.

alter table public.extracted_fields
  add column if not exists currency text,
  add column if not exists tax_amount numeric;

comment on column public.extracted_fields.currency is
  'ISO 4217 code as printed on the invoice (e.g. AED, USD).';
comment on column public.extracted_fields.tax_amount is
  'VAT/tax amount shown on the invoice, in invoice currency. Null = none found.';
