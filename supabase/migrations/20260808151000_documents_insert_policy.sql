-- Allow LedgerGate (anon) to insert uploaded documents under POC RLS.

create policy "documents_insert_poc"
  on public.documents for insert
  to anon, authenticated
  with check (true);

create policy "extracted_fields_insert_poc"
  on public.extracted_fields for insert
  to anon, authenticated
  with check (true);
