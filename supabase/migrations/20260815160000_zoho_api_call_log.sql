-- Zoho API usage accounting.
--
-- Zoho sends no rate-limit headers, so the app counts its own calls. Every
-- outbound Zoho request is logged with the user action that caused it
-- (the "click"), so the admin dashboard can show usage per action against
-- the org's plan limits. Limits themselves come from Zoho's published API
-- docs and the org's plan_name (GET /organizations) — see the dashboard
-- function; nothing about limits is stored here.

create table public.zoho_api_calls (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.company_config (company_id),
  called_at timestamptz not null default now(),
  -- What the user did that caused this call: sync, learn, push, month-end,
  -- extract, judgment. One click can cause many calls (a full sync is
  -- 11+ list calls; a learn is one call per document).
  action text not null,
  -- Which edge function made it.
  function_name text not null,
  -- HTTP method + Zoho path (organization_id and ids stripped for grouping).
  method text not null default 'GET',
  endpoint text not null,
  status integer,
  duration_ms integer,
  -- Correlates all calls from one click. Client sends X-Action-Id, or the
  -- function generates one per invocation.
  action_id text,
  -- Who clicked (reviewer name from the UI; free text for the POC).
  actor text,
  -- True when Zoho answered 429 — the thing the dashboard most wants to see.
  rate_limited boolean not null default false
);

create index zoho_api_calls_company_time_idx
  on public.zoho_api_calls (company_id, called_at desc);
create index zoho_api_calls_action_idx
  on public.zoho_api_calls (company_id, action_id);

alter table public.zoho_api_calls enable row level security;

-- Dashboard reads; functions (service role) write.
create policy "zoho_api_calls_read_poc"
  on public.zoho_api_calls for select to anon, authenticated using (true);
grant select on table public.zoho_api_calls to anon, authenticated;
grant select, insert, delete on table public.zoho_api_calls to service_role;

-- Cheap per-minute / per-day rollups for the dashboard.
create or replace view public.zoho_api_usage_today as
  select
    company_id,
    count(*)                                        as calls_today,
    count(*) filter (where rate_limited)            as rate_limited_today,
    count(*) filter (where called_at > now() - interval '1 minute') as calls_last_minute,
    max(called_at)                                  as last_call_at
  from public.zoho_api_calls
  where called_at >= date_trunc('day', now())
  group by company_id;

grant select on public.zoho_api_usage_today to anon, authenticated, service_role;
