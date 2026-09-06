-- Reading a company's Zoho refresh token out of Vault.
--
-- vault.decrypted_secrets is not reachable from PostgREST, so the edge
-- functions need a function to go through. It is SECURITY DEFINER, which
-- makes who may execute it the only thing standing between a browser and a
-- credential to somebody's accounting system — so execute is granted to
-- service_role and to nobody else, and the argument must be a secret id that
-- actually belongs to a zoho_connections row. A caller cannot use it to read
-- arbitrary secrets out of the vault.

create or replace function public.zoho_refresh_token(p_secret_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'vault'
as $$
declare
  v_token text;
begin
  -- Only ids that a connection actually points at. Without this the function
  -- would decrypt anything in the vault for whoever could call it.
  if not exists (
    select 1 from public.zoho_connections
    where refresh_token_secret_id = p_secret_id
  ) then
    raise exception 'No Zoho connection holds that secret';
  end if;

  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where id = p_secret_id;

  if v_token is null then
    raise exception 'That Zoho refresh token is not in the vault';
  end if;

  return v_token;
end;
$$;

revoke all on function public.zoho_refresh_token(uuid) from public;
revoke all on function public.zoho_refresh_token(uuid) from anon;
revoke all on function public.zoho_refresh_token(uuid) from authenticated;
grant execute on function public.zoho_refresh_token(uuid) to service_role;

comment on function public.zoho_refresh_token(uuid) is
  'Service-role only. Returns a company Zoho refresh token from Vault, and only for a secret id a zoho_connections row points at.';

-- Storing one. Same reasoning: server-side only.
create or replace function public.zoho_connect(
  p_company_id uuid,
  p_organization_id text,
  p_refresh_token text,
  p_accounts_url text default 'https://accounts.zoho.com',
  p_api_base_url text default 'https://www.zohoapis.com/books/v3'
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'vault'
as $$
declare
  v_secret_id uuid;
  v_existing uuid;
begin
  select refresh_token_secret_id into v_existing
  from public.zoho_connections where company_id = p_company_id;

  if v_existing is not null then
    -- Reconnecting: replace the token in place rather than leaving the old
    -- one decryptable in the vault.
    perform vault.update_secret(v_existing, p_refresh_token, null, null, null);
    v_secret_id := v_existing;
  else
    v_secret_id := vault.create_secret(
      p_refresh_token,
      'zoho_refresh_token:' || p_company_id::text,
      'Zoho Books refresh token for company ' || p_company_id::text,
      null
    );
  end if;

  insert into public.zoho_connections (
    company_id, organization_id, refresh_token_secret_id, accounts_url, api_base_url
  )
  values (
    p_company_id, p_organization_id, v_secret_id, p_accounts_url, p_api_base_url
  )
  on conflict (company_id) do update set
    organization_id = excluded.organization_id,
    refresh_token_secret_id = excluded.refresh_token_secret_id,
    accounts_url = excluded.accounts_url,
    api_base_url = excluded.api_base_url,
    updated_at = now();

  return v_secret_id;
end;
$$;

revoke all on function public.zoho_connect(uuid, text, text, text, text) from public;
revoke all on function public.zoho_connect(uuid, text, text, text, text) from anon;
revoke all on function public.zoho_connect(uuid, text, text, text, text) from authenticated;
grant execute on function public.zoho_connect(uuid, text, text, text, text) to service_role;

comment on function public.zoho_connect(uuid, text, text, text, text) is
  'Service-role only. Puts a company Zoho refresh token in Vault and records which organisation it reaches.';
