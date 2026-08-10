-- POC policies so the review dashboard (anon key) can read/update review data.
-- Tighten to authenticated roles before any real client data is loaded.

create policy "documents_select_poc"
  on public.documents for select
  using (true);

create policy "documents_update_poc"
  on public.documents for update
  using (true)
  with check (true);

create policy "extracted_fields_select_poc"
  on public.extracted_fields for select
  using (true);

create policy "extracted_fields_update_poc"
  on public.extracted_fields for update
  using (true)
  with check (true);

create policy "judgment_results_select_poc"
  on public.judgment_results for select
  using (true);

create policy "judgment_results_update_poc"
  on public.judgment_results for update
  using (true)
  with check (true);

create policy "judgment_results_insert_poc"
  on public.judgment_results for insert
  with check (true);

create policy "erp_sync_log_select_poc"
  on public.erp_sync_log for select
  using (true);
