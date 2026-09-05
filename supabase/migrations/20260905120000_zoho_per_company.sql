-- Zoho credentials belong to a company, not to the deployment.
--
-- Until now ZOHO_ORGANIZATION_ID and ZOHO_REFRESH_TOKEN were environment
-- variables, so every company on the deployment shared one Zoho organisation.
-- A practice cannot onboard a second client that way: whoever signed in would
-- be looking at the first client's books.
--
-- Two things were structurally single-company:
--
--   1. the credentials themselves, and
--   2. public.zoho_oauth_tokens, whose primary key carried CHECK (id = 1) —
--      literally one row for the whole deployment. With two companies the
--      second one's access token would overwrite the first's, and both would
--      then call Zoho as whoever wrote last.
--
-- The refresh token is a long-lived credential to somebody's accounting
-- system, so it does not sit in a table column. It goes in Vault, and this
-- table keeps only the id of the secret; reading the secret itself needs
-- rights that the browser's key does not have.

-- ---------------------------------------------------------------------------
-- 1) one Zoho connection per company
-- ---------------------------------------------------------------------------
create table if not exists public.zoho_connections (
  company_id uuid primary key
    references public.company_config (company_id) on delete cascade,
  organization_id text not null,
  -- vault.secrets.id — the refresh token lives there, never here.
  refresh_token_secret_id uuid not null,
  -- Zoho is regional: a UAE client is .ae, an EU client .eu. One practice can
  -- hold clients in different regions, so these travel with the connection.
  accounts_url text not null default 'https://accounts.zoho.com',
  api_base_url text not null default 'https://www.zohoapis.com/books/v3',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.zoho_connections is
  'Which Zoho organisation a company posts to, and where its refresh token is kept. One row per company.';
comment on column public.zoho_connections.refresh_token_secret_id is
  'vault.secrets.id. Decrypting it needs the service role; the anon and authenticated keys cannot.';

alter table public.zoho_connections enable row level security;

-- A member may see WHICH organisation their company is connected to and when.
-- The secret id is in the row, but it is inert without Vault access.
drop policy if exists "zoho_connections_select_company" on public.zoho_connections;
create policy "zoho_connections_select_company"
  on public.zoho_connections for select to authenticated
  using (public.user_in_company(company_id));

-- Connecting and disconnecting is a server-side act: it needs the client
-- secret and a token exchange, so no browser policy for insert or update.

-- ---------------------------------------------------------------------------
-- 2) the access-token cache becomes per company
-- ---------------------------------------------------------------------------
-- The old table could hold exactly one row. Rebuild it keyed by company, and
-- carry the existing token across so nothing has to re-authenticate.
create table if not exists public.zoho_access_tokens (
  company_id uuid primary key
    references public.company_config (company_id) on delete cascade,
  access_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.zoho_access_tokens enable row level security;
-- Nobody reads this from a browser. Service role only, which bypasses RLS.
-- The absence of a policy is the point, not an oversight.

comment on table public.zoho_access_tokens is
  'Short-lived Zoho access tokens, one per company. No RLS policy on purpose: only edge functions touch it.';

-- ---------------------------------------------------------------------------
-- 3) carry the existing single-company setup across
-- ---------------------------------------------------------------------------
-- The deployment's current Zoho org and refresh token are in environment
-- variables, which SQL cannot read. So this migration cannot fill in the
-- connection row — that is done once, by hand, with scripts/zoho-connect.mjs,
-- which reads the .env values and writes them here as the first company's
-- connection. The old token cache is dropped only after that has run.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'zoho_oauth_tokens'
  ) then
    raise notice
      'zoho_oauth_tokens still exists. Run `node scripts/zoho-connect.mjs` to move this deployment''s Zoho org and refresh token into zoho_connections, then drop it.';
  end if;
end $$;
