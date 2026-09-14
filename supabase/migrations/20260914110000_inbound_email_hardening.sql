-- The email ingest path: the one way into a client's books with no sign-in.
--
-- Three gaps closed at the database:
--
-- 1) Replay. Mailgun signs only timestamp + token, not the message. The
--    webhook kept no record of tokens it had accepted, so a captured
--    signature could be replayed with any attachment. inbound_webhook_receipts
--    remembers every accepted token; its primary key makes a second use fail
--    atomically. Service role only.
--
-- 2) Guessable mailbox match. The webhook looked the recipient up with ILIKE,
--    so % and _ in an address acted as wildcards. It now matches exactly, which
--    needs addresses stored in one case: they are lower-cased here, kept that
--    way by a CHECK, and unique regardless of case. A member of one company
--    also used to be able to change its inbound address from the browser —
--    and so collide with, or impersonate, another company's. Those columns
--    are now written only by assign_inbound_email() (service role).
--
-- 3) The bucket. Files in `invoices` are private and read only through signed
--    URLs; the bucket also enforces the size and type limits itself, so a
--    direct browser upload cannot exceed what the functions would accept.

-- ---------------------------------------------------------------------------
-- 1) webhook receipts
-- ---------------------------------------------------------------------------
create table if not exists public.inbound_webhook_receipts (
  token text primary key,
  signed_at timestamptz not null,
  received_at timestamptz not null default now()
);

create index if not exists inbound_webhook_receipts_received_at_idx
  on public.inbound_webhook_receipts (received_at);

alter table public.inbound_webhook_receipts enable row level security;
-- No policies: nothing but the service role touches it.
revoke all on table public.inbound_webhook_receipts from public, anon, authenticated;
grant select, insert, delete on table public.inbound_webhook_receipts to service_role;

comment on table public.inbound_webhook_receipts is
  'Mailgun webhook tokens already accepted, so a signed webhook cannot be replayed. Service role only; rows older than the signature window are pruned by inbound-email.';

-- ---------------------------------------------------------------------------
-- 2) inbound addresses: one case, unique, not browser-writable
-- ---------------------------------------------------------------------------
update public.company_config
set inbound_email = lower(trim(inbound_email)),
    inbound_local_part = lower(trim(inbound_local_part))
where inbound_email is distinct from lower(trim(inbound_email))
   or inbound_local_part is distinct from lower(trim(inbound_local_part));

alter table public.company_config
  drop constraint if exists company_config_inbound_email_lowercase;
alter table public.company_config
  add constraint company_config_inbound_email_lowercase
  check (inbound_email is null or inbound_email = lower(inbound_email));

drop index if exists public.company_config_inbound_email_lookup_idx;
create unique index if not exists company_config_inbound_email_lower_uidx
  on public.company_config (lower(inbound_email))
  where inbound_email is not null;

-- Table-level UPDATE covers every column, so it is replaced by a column list
-- that leaves out the mailbox columns. Built from the catalogue so columns
-- added later by other migrations stay editable as they were.
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'company_config'
    and column_name not in ('company_id', 'company_slug', 'inbound_local_part', 'inbound_email');

  revoke update on table public.company_config from authenticated;
  execute format('grant update (%s) on table public.company_config to authenticated', v_cols);
end $$;

-- The only writer of those columns. Service role only, on every role that
-- might hold a default EXECUTE grant.
revoke all on function public.assign_inbound_email(uuid, text, text) from public, anon, authenticated;
grant execute on function public.assign_inbound_email(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3) the bucket enforces privacy, size and type
-- ---------------------------------------------------------------------------
update storage.buckets
set public = false,
    file_size_limit = 52428800,
    allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
where id = 'invoices';

do $$
begin
  if exists (select 1 from storage.buckets where id = 'invoices' and public) then
    raise exception 'invoices bucket is still public';
  end if;
end $$;
