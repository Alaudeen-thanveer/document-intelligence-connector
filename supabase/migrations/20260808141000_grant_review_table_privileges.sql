-- Supabase no longer auto-exposes new public tables to API roles.
-- Grant the privileges the review dashboard needs (POC).

grant select, update on table public.documents to anon, authenticated;
grant select, update on table public.extracted_fields to anon, authenticated;
grant select, insert, update on table public.judgment_results to anon, authenticated;
grant select on table public.erp_sync_log to anon, authenticated;

-- Also allow inserting sample/test documents from Studio or the API during POC.
grant insert on table public.documents to anon, authenticated;
grant insert on table public.extracted_fields to anon, authenticated;
