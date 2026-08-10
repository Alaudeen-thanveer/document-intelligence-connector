-- Public invoices bucket for LedgerGate manual uploads (POC).
-- Public so edge functions can fetch file_url without signed-URL plumbing yet.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'invoices',
  'invoices',
  true,
  52428800,
  array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "invoices_objects_select_poc"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'invoices');

create policy "invoices_objects_insert_poc"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'invoices');

create policy "invoices_objects_update_poc"
  on storage.objects for update
  to anon, authenticated
  using (bucket_id = 'invoices')
  with check (bucket_id = 'invoices');
