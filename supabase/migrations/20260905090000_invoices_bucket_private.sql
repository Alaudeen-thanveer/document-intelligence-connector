-- The invoices bucket was public. An unauthenticated GET to
--   /storage/v1/object/public/invoices/{company_id}/{file}
-- returned 200 and the PDF — vendor names, amounts, bank details, TRNs — to
-- anyone holding or guessing an object path.
--
-- 20260817153000 already set `public = false`. It was undone, and the reason
-- is in the migration that creates the bucket (20260808150000):
--
--   on conflict (id) do update set
--     public = excluded.public,   -- excluded.public is TRUE
--
-- so any replay of that earlier file re-opens the bucket, silently, with no
-- error and nothing on screen to show it. That clause has been changed to
-- leave `public` alone on conflict, so the only statement in the repository
-- that can turn this bucket public is the initial insert into an empty
-- database — which this migration then closes again.
--
-- Nothing depends on the bucket being public: every edge function reads the
-- file with the service-role client's .download(), which ignores bucket
-- visibility, and the web app signs a URL. The public marker those functions
-- look for in file_url is only used to slice the object path back out.

update storage.buckets
set public = false
where id = 'invoices';

do $$
begin
  if exists (
    select 1 from storage.buckets where id = 'invoices' and public
  ) then
    raise exception
      'invoices bucket is still public after this migration — refusing to leave customer documents exposed';
  end if;
end $$;
