-- Bank tables join the company-membership security model.
--
-- The bank layers (bk_bank_patterns, bank_statements, bank_statement_lines)
-- were built with the open POC policies the rest of the schema used at the
-- time. The auth hardening (company_id_rls, company_members_child_rls)
-- replaced those with company-scoped policies for authenticated users and
-- no anon access. This does the same for the bank tables, and removes the
-- one policy the bank phase-1 migration had added that re-opened
-- company_config updates to anon.
--
-- Edge functions use the service role and are unaffected.

-- ---------------------------------------------------------------------------
-- company_config: undo the POC update policy from bank phase 1. The
-- company-scoped update policy from company_id_rls already covers the
-- reviewer editing the three bank policies.
-- ---------------------------------------------------------------------------
drop policy if exists "company_config_update_poc" on public.company_config;
revoke update on table public.company_config from anon;

-- ---------------------------------------------------------------------------
-- bk_bank_patterns
-- ---------------------------------------------------------------------------
drop policy if exists "bk_bank_patterns_poc" on public.bk_bank_patterns;
create policy "bk_bank_patterns_select_company"
  on public.bk_bank_patterns for select to authenticated
  using (company_id = public.current_company_id());
create policy "bk_bank_patterns_update_company"
  on public.bk_bank_patterns for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
revoke all on table public.bk_bank_patterns from anon, public;
grant select, update on table public.bk_bank_patterns to authenticated;

-- ---------------------------------------------------------------------------
-- bank_statements
-- ---------------------------------------------------------------------------
drop policy if exists "bank_statements_poc" on public.bank_statements;
create policy "bank_statements_select_company"
  on public.bank_statements for select to authenticated
  using (company_id = public.current_company_id());
create policy "bank_statements_insert_company"
  on public.bank_statements for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bank_statements_update_company"
  on public.bank_statements for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
revoke all on table public.bank_statements from anon, public;
grant select, insert, update on table public.bank_statements to authenticated;

-- ---------------------------------------------------------------------------
-- bank_statement_lines
-- ---------------------------------------------------------------------------
drop policy if exists "bank_statement_lines_poc" on public.bank_statement_lines;
create policy "bank_statement_lines_select_company"
  on public.bank_statement_lines for select to authenticated
  using (company_id = public.current_company_id());
create policy "bank_statement_lines_insert_company"
  on public.bank_statement_lines for insert to authenticated
  with check (company_id = public.current_company_id());
create policy "bank_statement_lines_update_company"
  on public.bank_statement_lines for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
revoke all on table public.bank_statement_lines from anon, public;
grant select, insert, update on table public.bank_statement_lines to authenticated;
