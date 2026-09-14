-- Zoho access tokens are encrypted at rest, like the refresh tokens.
--
-- The refresh token already lives in Vault. The access token it mints did
-- not: zoho_access_tokens.access_token was a plain text column. It lives an
-- hour, but for that hour it is a working bearer credential to a client's
-- accounting system, and a database read or a pg_dump handed it over in the
-- clear. Anyone holding a dump taken inside that window could post into the
-- client's books.
--
-- Now the cache row keeps only a Vault secret id and the expiry. The token is
-- written and read through two SECURITY DEFINER functions granted to
-- service_role alone, the same shape as zoho_refresh_token().
--
-- Existing cached tokens are dropped, not migrated: they are a cache, and the
-- next Zoho call for each company mints a fresh one.
--
-- Deleting a connection or a cache row now deletes its Vault secret too, so a
-- disconnected company does not leave a decryptable token behind.

-- ---------------------------------------------------------------------------
-- 1) the cache row: secret id + expiry, no token
-- ---------------------------------------------------------------------------
delete from public.zoho_access_tokens;

alter table public.zoho_access_tokens
  drop column if exists access_token,
  add column if not exists access_token_secret_id uuid not null;

comment on table public.zoho_access_tokens is
  'Per-company Zoho access-token cache. The token itself is in Vault (access_token_secret_id); this row holds only the secret id and expiry. Service role only.';

-- Nobody but the service role addresses either Zoho table's secrets.
revoke all on table public.zoho_access_tokens from public, anon, authenticated;
revoke all on table public.zoho_connections from public, anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.zoho_connections from authenticated;

-- ---------------------------------------------------------------------------
-- 2) write
-- ---------------------------------------------------------------------------
create or replace function public.zoho_access_token_put(
  p_company_id uuid,
  p_access_token text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if p_access_token is null or length(trim(p_access_token)) = 0 then
    raise exception 'Empty access token';
  end if;
  if not exists (
    select 1 from public.zoho_connections where company_id = p_company_id
  ) then
    raise exception 'No Zoho connection for that company';
  end if;

  select access_token_secret_id into v_secret_id
  from public.zoho_access_tokens
  where company_id = p_company_id
  for update;

  if v_secret_id is not null
     and exists (select 1 from vault.secrets where id = v_secret_id) then
    perform vault.update_secret(v_secret_id, p_access_token, null, null, null);
  else
    v_secret_id := vault.create_secret(
      p_access_token,
      'zoho_access_token:' || p_company_id::text || ':' || gen_random_uuid()::text,
      'Zoho Books access token (short-lived) for company ' || p_company_id::text,
      null
    );
  end if;

  insert into public.zoho_access_tokens (company_id, access_token_secret_id, expires_at, updated_at)
  values (p_company_id, v_secret_id, p_expires_at, now())
  on conflict (company_id) do update set
    access_token_secret_id = excluded.access_token_secret_id,
    expires_at = excluded.expires_at,
    updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) read: only a token that has not expired
-- ---------------------------------------------------------------------------
create or replace function public.zoho_access_token_get(p_company_id uuid)
returns table (access_token text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret, t.expires_at
  from public.zoho_access_tokens t
  join vault.decrypted_secrets s on s.id = t.access_token_secret_id
  where t.company_id = p_company_id
    and t.expires_at > now();
$$;

revoke all on function public.zoho_access_token_put(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.zoho_access_token_get(uuid) from public, anon, authenticated;
grant execute on function public.zoho_access_token_put(uuid, text, timestamptz) to service_role;
grant execute on function public.zoho_access_token_get(uuid) to service_role;

comment on function public.zoho_access_token_put(uuid, text, timestamptz) is
  'Service-role only. Stores a company Zoho access token in Vault and records its expiry.';
comment on function public.zoho_access_token_get(uuid) is
  'Service-role only. Returns a company''s unexpired Zoho access token from Vault, or no row.';

-- ---------------------------------------------------------------------------
-- 4) no orphaned secrets
-- ---------------------------------------------------------------------------
create or replace function public.zoho_delete_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'zoho_access_tokens' then
    delete from vault.secrets where id = old.access_token_secret_id;
  elsif tg_table_name = 'zoho_connections' then
    delete from vault.secrets where id = old.refresh_token_secret_id;
  end if;
  return old;
end;
$$;

revoke all on function public.zoho_delete_vault_secret() from public, anon, authenticated;

drop trigger if exists zoho_access_tokens_delete_secret on public.zoho_access_tokens;
create trigger zoho_access_tokens_delete_secret
  after delete on public.zoho_access_tokens
  for each row execute function public.zoho_delete_vault_secret();

drop trigger if exists zoho_connections_delete_secret on public.zoho_connections;
create trigger zoho_connections_delete_secret
  after delete on public.zoho_connections
  for each row execute function public.zoho_delete_vault_secret();

-- ---------------------------------------------------------------------------
-- 5) guard: no Zoho credential sits in a plain column anywhere in public
-- ---------------------------------------------------------------------------
do $$
declare
  v_cols text;
begin
  select string_agg(table_name || '.' || column_name, ', ')
    into v_cols
  from information_schema.columns
  where table_schema = 'public'
    and data_type in ('text', 'character varying')
    and column_name in ('access_token', 'refresh_token', 'client_secret');
  if v_cols is not null then
    raise exception 'Plaintext credential columns remain in public: %', v_cols;
  end if;
end $$;
