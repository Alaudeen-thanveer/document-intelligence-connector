-- Ensure service_role (used by edge functions) can read/write pipeline tables.
grant select, insert, update, delete on table public.documents to service_role;
grant select, insert, update, delete on table public.extracted_fields to service_role;
grant select, insert, update, delete on table public.judgment_results to service_role;
grant select, insert, update, delete on table public.erp_sync_log to service_role;
grant select, insert, update, delete on table public.company_config to service_role;
