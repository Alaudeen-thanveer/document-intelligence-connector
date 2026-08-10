-- Expose review tables to Supabase Realtime for the dashboard.
alter publication supabase_realtime add table public.documents;
alter publication supabase_realtime add table public.extracted_fields;
alter publication supabase_realtime add table public.judgment_results;
