-- Cache the Zoho OAuth access token between edge-function calls.
-- Zoho throttles the token-refresh endpoint hard; minting a fresh token on
-- every function call locks the connection out under normal review usage.
-- Tokens live ~1 hour; one row holds the current one.

create table public.zoho_oauth_tokens (
  id integer primary key default 1 check (id = 1),
  access_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.zoho_oauth_tokens enable row level security;

-- Service-role only: the token is a secret and the dashboard never needs it.
grant select, insert, update, delete on table public.zoho_oauth_tokens
  to service_role;
