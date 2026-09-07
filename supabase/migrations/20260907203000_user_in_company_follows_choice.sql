-- user_in_company() follows the company switcher.
--
-- It used to answer "the current company, OR any company this person is a
-- member of". For a person in one company those are the same thing. For a
-- person in several, the tables guarded by it (documents, the account
-- rules, the Zoho masters, the invoice files) showed EVERY company they
-- belonged to at once, while the tables guarded by current_company_id()
-- showed one - a mixed view, with nothing on screen saying which rows
-- were whose. The company switcher exists to remove exactly that.
--
-- Now membership is still the hard boundary - nothing outside it is ever
-- visible - and within it, the view is the one company the person is
-- working in: the one they chose, else the login stamp, else their only
-- membership. Several memberships and no choice: nothing, until they
-- choose. For a person in one company nothing changes.
create or replace function public.user_in_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_company_id is not null
    and p_company_id = public.current_company_id()
    and exists (
      select 1
      from public.company_members m
      where m.user_id = auth.uid()
        and m.company_id = p_company_id
    );
$$;
