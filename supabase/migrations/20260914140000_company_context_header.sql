-- Edge functions act as the signed-in person, so RLS must know which company.
--
-- Edge functions now query with the caller's own JWT, so row-level security
-- applies to them exactly as it does to the browser, instead of the service
-- role bypassing it. They resolve the company first (companyForCaller, which
-- checks membership) and must then have RLS agree on that company.
--
-- For a person in one company, or one who has chosen a company in the
-- switcher, current_company_id() already answers. For a person in several
-- companies acting on a document of a company they have not selected — which
-- the edge guard allows, because membership decides — it would answer the
-- selection (or nothing), and the function would see no rows.
--
-- So a request may name its company in an `x-company-id` header. It is
-- honoured only when auth.uid() is a member of that company; it can narrow
-- the view to one of the caller's own companies and never widen it. Anything
-- that is not a UUID is ignored.

create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with requested as (
    select case
      when h ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then h::uuid
    end as company_id
    from (
      select nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-company-id' as h
    ) raw
  )
  select coalesce(
    -- the company this request names, only while a member of it
    (
      select m.company_id
      from public.company_members m, requested r
      where m.user_id = auth.uid()
        and m.company_id = r.company_id
    ),
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

revoke all on function public.current_company_id() from public, anon;
grant execute on function public.current_company_id() to authenticated, service_role;
