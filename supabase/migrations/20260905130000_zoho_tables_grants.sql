-- Grants for the two Zoho tables.
--
-- Row-level security decides WHICH rows a role may see; the grant decides
-- whether the role may address the table at all. The service role bypasses
-- RLS but not grants, so without this the edge functions got
-- "permission denied for table zoho_connections" and no Zoho call could be
-- made by anyone.

-- Edge functions read the connection and keep the access-token cache.
grant select, insert, update, delete on public.zoho_connections to service_role;
grant select, insert, update, delete on public.zoho_access_tokens to service_role;

-- A member may see which organisation their own company is connected to.
-- The row-level policy on zoho_connections already limits that to their
-- company; this only permits the table to be addressed at all.
grant select on public.zoho_connections to authenticated;

-- zoho_access_tokens is deliberately NOT granted to authenticated or anon.
-- It holds live bearer tokens for somebody's accounting system, has no RLS
-- policy, and nothing in the browser has any reason to read it.
