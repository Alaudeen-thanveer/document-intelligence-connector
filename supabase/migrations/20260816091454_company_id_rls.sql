-- Company-scoped RLS for every public table that has a company_id column.
--
-- Auth: Supabase Auth (not Clerk). Clerk is disabled in supabase/config.toml.
-- Claim path: auth.jwt() -> 'app_metadata' ->> 'company_id'
--   (app_metadata is admin-set; user_metadata is user-editable and must not
--   be used for authorization.)
--
-- Tables touched (have company_id):
--   1. company_config
--   2. documents
--   3. bk_party_profiles
--   4. bk_suggestion_log
--   5. bk_history_raw
--   6. bk_learn_runs
--   7. bk_rhythms
--   8. bk_check_proposals
--   9. bk_attachment_conventions
--  10. bk_party_tag_profiles
--  11. bk_party_project_profiles
--  12. bk_account_tag_profiles
--  13. bk_timing_profiles
--  14. bk_journal_patterns
--  15. zoho_api_calls
--  16. audit_log
--
-- Also tightened (not a table, but exposes company_id):
--   zoho_api_usage_today  — view; recreated SECURITY INVOKER so it
--   inherits zoho_api_calls RLS instead of bypassing it.
--
-- Checked, no company_id — left unchanged:
--   invoices              — does not exist; invoices are public.documents
--   vendors               — does not exist; cached as zoho_entities.kind='vendor'
--   line_items            — public.extracted_line_items (scoped via document_id)
--   extracted_fields, extracted_line_items, judgment_results, erp_sync_log
--   vendor_account_rules, customer_account_rules, zoho_entities
--   zoho_oauth_tokens
--
-- audit_log stays append-only: SELECT + INSERT only (no UPDATE/DELETE).
-- anon / public get no grants. service_role keeps existing grants and
-- bypasses RLS as usual (edge functions only).

create or replace function public.current_company_id()
returns uuid
language sql
stable
as $$
  select (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
$$;

revoke all on function public.current_company_id() from public;
grant execute on function public.current_company_id() to authenticated;

-- ---------------------------------------------------------------------------
-- Drop open POC policies on company_id tables (they allowed anon).
-- ---------------------------------------------------------------------------
drop policy if exists "company_config_select_poc" on public.company_config;
drop policy if exists "documents_select_poc" on public.documents;
drop policy if exists "documents_update_poc" on public.documents;
drop policy if exists "documents_insert_poc" on public.documents;
drop policy if exists "bk_party_profiles_poc" on public.bk_party_profiles;
drop policy if exists "bk_suggestion_log_poc" on public.bk_suggestion_log;
drop policy if exists "bk_learn_runs_read_poc" on public.bk_learn_runs;
drop policy if exists "bk_rhythms_read_poc" on public.bk_rhythms;
drop policy if exists "bk_check_proposals_poc" on public.bk_check_proposals;
drop policy if exists "bk_attachment_conventions_read_poc" on public.bk_attachment_conventions;
drop policy if exists "bk_party_tag_profiles_poc" on public.bk_party_tag_profiles;
drop policy if exists "bk_party_project_profiles_poc" on public.bk_party_project_profiles;
drop policy if exists "bk_account_tag_profiles_poc" on public.bk_account_tag_profiles;
drop policy if exists "bk_timing_profiles_read_poc" on public.bk_timing_profiles;
drop policy if exists "bk_journal_patterns_poc" on public.bk_journal_patterns;
drop policy if exists "zoho_api_calls_read_poc" on public.zoho_api_calls;
drop policy if exists "audit_log_select_company" on public.audit_log;

-- ---------------------------------------------------------------------------
-- company_config
-- ---------------------------------------------------------------------------
alter table public.company_config enable row level security;

create policy "company_config_select_company"
  on public.company_config for select to authenticated
  using (company_id = public.current_company_id());
create policy "company_config_insert_company"
  on public.company_config for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "company_config_update_company"
  on public.company_config for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.company_config from anon, public;
grant select, insert, update on table public.company_config to authenticated;

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
alter table public.documents enable row level security;

create policy "documents_select_company"
  on public.documents for select to authenticated
  using (company_id = public.current_company_id());
create policy "documents_insert_company"
  on public.documents for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "documents_update_company"
  on public.documents for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.documents from anon, public;
grant select, insert, update on table public.documents to authenticated;

-- ---------------------------------------------------------------------------
-- bk_party_profiles
-- ---------------------------------------------------------------------------
alter table public.bk_party_profiles enable row level security;

create policy "bk_party_profiles_select_company"
  on public.bk_party_profiles for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_party_profiles_insert_company"
  on public.bk_party_profiles for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_party_profiles_update_company"
  on public.bk_party_profiles for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_party_profiles from anon, public;
grant select, insert, update on table public.bk_party_profiles to authenticated;

-- ---------------------------------------------------------------------------
-- bk_suggestion_log
-- ---------------------------------------------------------------------------
alter table public.bk_suggestion_log enable row level security;

create policy "bk_suggestion_log_select_company"
  on public.bk_suggestion_log for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_suggestion_log_insert_company"
  on public.bk_suggestion_log for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_suggestion_log_update_company"
  on public.bk_suggestion_log for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_suggestion_log from anon, public;
grant select, insert, update on table public.bk_suggestion_log to authenticated;

-- ---------------------------------------------------------------------------
-- bk_history_raw
-- ---------------------------------------------------------------------------
alter table public.bk_history_raw enable row level security;

create policy "bk_history_raw_select_company"
  on public.bk_history_raw for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_history_raw_insert_company"
  on public.bk_history_raw for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_history_raw_update_company"
  on public.bk_history_raw for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_history_raw from anon, public;
grant select, insert, update on table public.bk_history_raw to authenticated;

-- ---------------------------------------------------------------------------
-- bk_learn_runs
-- ---------------------------------------------------------------------------
alter table public.bk_learn_runs enable row level security;

create policy "bk_learn_runs_select_company"
  on public.bk_learn_runs for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_learn_runs_insert_company"
  on public.bk_learn_runs for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_learn_runs_update_company"
  on public.bk_learn_runs for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_learn_runs from anon, public;
grant select, insert, update on table public.bk_learn_runs to authenticated;

-- ---------------------------------------------------------------------------
-- bk_rhythms
-- ---------------------------------------------------------------------------
alter table public.bk_rhythms enable row level security;

create policy "bk_rhythms_select_company"
  on public.bk_rhythms for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_rhythms_insert_company"
  on public.bk_rhythms for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_rhythms_update_company"
  on public.bk_rhythms for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_rhythms from anon, public;
grant select, insert, update on table public.bk_rhythms to authenticated;

-- ---------------------------------------------------------------------------
-- bk_check_proposals
-- ---------------------------------------------------------------------------
alter table public.bk_check_proposals enable row level security;

create policy "bk_check_proposals_select_company"
  on public.bk_check_proposals for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_check_proposals_insert_company"
  on public.bk_check_proposals for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_check_proposals_update_company"
  on public.bk_check_proposals for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_check_proposals from anon, public;
grant select, insert, update on table public.bk_check_proposals to authenticated;

-- ---------------------------------------------------------------------------
-- bk_attachment_conventions
-- ---------------------------------------------------------------------------
alter table public.bk_attachment_conventions enable row level security;

create policy "bk_attachment_conventions_select_company"
  on public.bk_attachment_conventions for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_attachment_conventions_insert_company"
  on public.bk_attachment_conventions for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_attachment_conventions_update_company"
  on public.bk_attachment_conventions for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_attachment_conventions from anon, public;
grant select, insert, update on table public.bk_attachment_conventions to authenticated;

-- ---------------------------------------------------------------------------
-- bk_party_tag_profiles
-- ---------------------------------------------------------------------------
alter table public.bk_party_tag_profiles enable row level security;

create policy "bk_party_tag_profiles_select_company"
  on public.bk_party_tag_profiles for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_party_tag_profiles_insert_company"
  on public.bk_party_tag_profiles for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_party_tag_profiles_update_company"
  on public.bk_party_tag_profiles for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_party_tag_profiles from anon, public;
grant select, insert, update on table public.bk_party_tag_profiles to authenticated;

-- ---------------------------------------------------------------------------
-- bk_party_project_profiles
-- ---------------------------------------------------------------------------
alter table public.bk_party_project_profiles enable row level security;

create policy "bk_party_project_profiles_select_company"
  on public.bk_party_project_profiles for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_party_project_profiles_insert_company"
  on public.bk_party_project_profiles for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_party_project_profiles_update_company"
  on public.bk_party_project_profiles for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_party_project_profiles from anon, public;
grant select, insert, update on table public.bk_party_project_profiles to authenticated;

-- ---------------------------------------------------------------------------
-- bk_account_tag_profiles
-- ---------------------------------------------------------------------------
alter table public.bk_account_tag_profiles enable row level security;

create policy "bk_account_tag_profiles_select_company"
  on public.bk_account_tag_profiles for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_account_tag_profiles_insert_company"
  on public.bk_account_tag_profiles for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_account_tag_profiles_update_company"
  on public.bk_account_tag_profiles for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_account_tag_profiles from anon, public;
grant select, insert, update on table public.bk_account_tag_profiles to authenticated;

-- ---------------------------------------------------------------------------
-- bk_timing_profiles
-- ---------------------------------------------------------------------------
alter table public.bk_timing_profiles enable row level security;

create policy "bk_timing_profiles_select_company"
  on public.bk_timing_profiles for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_timing_profiles_insert_company"
  on public.bk_timing_profiles for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_timing_profiles_update_company"
  on public.bk_timing_profiles for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_timing_profiles from anon, public;
grant select, insert, update on table public.bk_timing_profiles to authenticated;

-- ---------------------------------------------------------------------------
-- bk_journal_patterns
-- ---------------------------------------------------------------------------
alter table public.bk_journal_patterns enable row level security;

create policy "bk_journal_patterns_select_company"
  on public.bk_journal_patterns for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_journal_patterns_insert_company"
  on public.bk_journal_patterns for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bk_journal_patterns_update_company"
  on public.bk_journal_patterns for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.bk_journal_patterns from anon, public;
grant select, insert, update on table public.bk_journal_patterns to authenticated;

-- ---------------------------------------------------------------------------
-- zoho_api_calls
-- ---------------------------------------------------------------------------
alter table public.zoho_api_calls enable row level security;

create policy "zoho_api_calls_select_company"
  on public.zoho_api_calls for select to authenticated
  using (company_id = public.current_company_id());
create policy "zoho_api_calls_insert_company"
  on public.zoho_api_calls for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "zoho_api_calls_update_company"
  on public.zoho_api_calls for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

revoke all on table public.zoho_api_calls from anon, public;
grant select, insert, update on table public.zoho_api_calls to authenticated;

-- ---------------------------------------------------------------------------
-- audit_log (append-only: SELECT + INSERT, no UPDATE/DELETE)
-- ---------------------------------------------------------------------------
alter table public.audit_log enable row level security;

create policy "audit_log_select_company"
  on public.audit_log for select to authenticated
  using (company_id = public.current_company_id());
create policy "audit_log_insert_company"
  on public.audit_log for insert to authenticated
  with check (company_id = public.current_company_id());

revoke all on table public.audit_log from anon, public;
grant select, insert on table public.audit_log to authenticated;

-- ---------------------------------------------------------------------------
-- zoho_api_usage_today: stop the view from bypassing RLS
-- ---------------------------------------------------------------------------
create or replace view public.zoho_api_usage_today
  with (security_invoker = true)
as
  select
    company_id,
    count(*)                                        as calls_today,
    count(*) filter (where rate_limited)            as rate_limited_today,
    count(*) filter (where called_at > now() - interval '1 minute') as calls_last_minute,
    max(called_at)                                  as last_call_at
  from public.zoho_api_calls
  where called_at >= date_trunc('day', now())
  group by company_id;

revoke all on public.zoho_api_usage_today from anon, public;
grant select on public.zoho_api_usage_today to authenticated, service_role;
