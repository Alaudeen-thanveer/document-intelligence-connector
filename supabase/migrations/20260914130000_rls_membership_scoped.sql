-- Every tenant policy is scoped through company membership and auth.uid().
--
-- Standard: no anon access to tenant tables; every policy scoped through
-- company_members + auth.uid(); no `using (true)`.
--
-- What fell short:
--
-- 1) current_company_id() trusted the company stamped on the login
--    (app_metadata.company_id) without checking company_members. About
--    thirty policies were `company_id = current_company_id()`, so a person
--    removed from a company kept reading and writing its bank statements,
--    audit log, raw Zoho history and settings for as long as the stamp
--    stayed on their account. Now every branch requires a membership row
--    for auth.uid(), and every one of those policies is rewritten to
--    user_in_company(company_id), which checks membership explicitly.
--
-- 2) anon and authenticated held TRUNCATE, REFERENCES and TRIGGER on tenant
--    tables (TRUNCATE ignores row-level security), anon held privileges on
--    several tables, and default privileges handed the same to every table
--    created later. All revoked, defaults included.
--
-- 3) Four tables defaulted company_id to one hard-coded company, so any
--    insert that forgot the column filed a row into that company. The
--    default is now the caller's own membership-checked company, which is
--    null — and so fails NOT NULL — for the service role or anyone without
--    one.
--
-- The migration ends with guards that fail the deploy if any of this
-- regresses.

-- ---------------------------------------------------------------------------
-- 1) the current company requires a membership, on every branch
-- ---------------------------------------------------------------------------
create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    -- the company chosen in the switcher, while still a member
    (
      select s.company_id
      from public.user_company_selection s
      join public.company_members m
        on m.user_id = s.user_id and m.company_id = s.company_id
      where s.user_id = auth.uid()
    ),
    -- the company stamped on the login, only while still a member
    (
      select m.company_id
      from public.company_members m
      where m.user_id = auth.uid()
        and m.company_id = nullif(auth.jwt() -> 'app_metadata' ->> 'company_id', '')::uuid
    ),
    -- the only company this person belongs to
    (
      select m.company_id
      from public.company_members m
      where m.user_id = auth.uid()
        and (select count(*) from public.company_members x where x.user_id = auth.uid()) = 1
    )
  );
$$;

create or replace function public.user_in_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.uid() is not null
    and p_company_id is not null
    and p_company_id = public.current_company_id()
    and exists (
      select 1
      from public.company_members m
      where m.user_id = auth.uid()
        and m.company_id = p_company_id
    );
$$;

revoke all on function public.current_company_id() from public, anon;
revoke all on function public.user_in_company(uuid) from public, anon;
grant execute on function public.current_company_id() to authenticated, service_role;
grant execute on function public.user_in_company(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) every `company_id = current_company_id()` policy → user_in_company()
-- ---------------------------------------------------------------------------
do $$
declare
  p record;
  v_old constant text := '(company_id = current_company_id())';
  v_new constant text := 'public.user_in_company(company_id)';
  v_sql text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') like '%current_company_id()%'
        or coalesce(with_check, '') like '%current_company_id()%')
  loop
    if coalesce(p.qual, v_old) <> v_old or coalesce(p.with_check, v_old) <> v_old then
      raise exception 'policy %.% has an unexpected expression; rewrite it by hand', p.tablename, p.policyname;
    end if;
    v_sql := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if p.qual is not null then
      v_sql := v_sql || ' using (' || v_new || ')';
    end if;
    if p.with_check is not null then
      v_sql := v_sql || ' with check (' || v_new || ')';
    end if;
    execute v_sql;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3) privileges: nothing for anon; no RLS-bypassing privileges for anyone
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.relname, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    execute format('revoke all on table public.%I from anon, public', r.relname);
    execute format('revoke truncate, references, trigger on table public.%I from authenticated', r.relname);
    begin
      execute format('revoke maintain on table public.%I from anon, authenticated', r.relname);
    exception when others then null; -- MAINTAIN exists from Postgres 17
    end;
  end loop;
end $$;

revoke all on all sequences in schema public from anon, public;
revoke execute on all functions in schema public from anon, public;

-- The same for everything created from now on.
alter default privileges in schema public revoke all on tables from anon, public;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;
alter default privileges in schema public revoke all on sequences from anon, public;
alter default privileges in schema public revoke execute on functions from anon, public;
do $$
begin
  alter default privileges for role postgres in schema public revoke all on tables from anon;
  alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from authenticated;
  alter default privileges for role postgres in schema public revoke all on sequences from anon;
  alter default privileges for role postgres in schema public revoke execute on functions from anon, public;
exception when insufficient_privilege then
  raise notice 'default privileges for role postgres left as they were (insufficient privilege)';
end $$;
do $$
begin
  execute 'alter default privileges for role postgres in schema public revoke maintain on tables from anon, authenticated';
exception when others then null;
end $$;

-- ---------------------------------------------------------------------------
-- 4) company_id defaults to the caller's own company, never a fixed one
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select table_name
    from information_schema.columns
    where table_schema = 'public'
      and column_name = 'company_id'
      and column_default like '%00000000-0000-4000-8000-000000000001%'
  loop
    execute format(
      'alter table public.%I alter column company_id set default public.current_company_id()',
      r.table_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5) guards: the deploy fails if any of this is not true
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  -- every table has RLS on
  select string_agg(c.relname, ', ') into v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if v is not null then raise exception 'RLS is off on: %', v; end if;

  -- no policy is open
  select string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') into v
  from pg_policies
  where schemaname in ('public', 'storage')
    and (btrim(coalesce(qual, ''), '() ') = 'true' or btrim(coalesce(with_check, ''), '() ') = 'true');
  if v is not null then raise exception 'policies open to every row: %', v; end if;

  -- no policy is for anon or public
  select string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') into v
  from pg_policies
  where schemaname = 'public' and (roles && array['anon', 'public']::name[]);
  if v is not null then raise exception 'policies for anon/public: %', v; end if;

  -- no policy still trusts the login stamp alone
  select string_agg(tablename || '.' || policyname, ', ') into v
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') || coalesce(with_check, '')) like '%current_company_id()%'
    and (coalesce(qual, '') || coalesce(with_check, '')) not like '%user_in_company%';
  if v is not null then raise exception 'policies not scoped through membership: %', v; end if;

  -- every policy on a company-scoped table goes through membership or auth.uid()
  select string_agg(p.tablename || '.' || p.policyname, ', ') into v
  from pg_policies p
  where p.schemaname = 'public'
    and (coalesce(p.qual, '') || coalesce(p.with_check, '')) not like '%user_in_company%'
    and (coalesce(p.qual, '') || coalesce(p.with_check, '')) not like '%auth.uid()%';
  if v is not null then raise exception 'policies not scoped to the caller: %', v; end if;

  -- anon holds nothing in public
  select string_agg(table_name || ':' || privilege_type, ', ') into v
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public';
  if v is not null then raise exception 'anon still holds: %', v; end if;

  select string_agg(p.proname, ', ') into v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
  if v is not null then raise exception 'anon can still execute: %', v; end if;

  -- nobody but the owner and service role can TRUNCATE a tenant table
  select string_agg(table_name || ':' || grantee, ', ') into v
  from information_schema.role_table_grants
  where table_schema = 'public' and privilege_type = 'TRUNCATE'
    and grantee in ('anon', 'authenticated', 'PUBLIC');
  if v is not null then raise exception 'TRUNCATE still granted: %', v; end if;
end $$;
