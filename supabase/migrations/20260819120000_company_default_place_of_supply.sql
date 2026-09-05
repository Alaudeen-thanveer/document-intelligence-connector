-- UAE VAT: Zoho requires place_of_supply (emirate code) on every sales
-- invoice. Contacts in the UAE edition carry no place-of-contact field, so
-- the company keeps a default here; zoho-approve uses, in order: explicit
-- input → the customer's billing state code → this default → the Zoho
-- organisation's own emirate.
alter table public.company_config
  add column if not exists default_place_of_supply text;
