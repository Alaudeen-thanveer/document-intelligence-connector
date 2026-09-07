-- The company switcher: a person who belongs to several companies chooses
-- which one they are working in, and everything follows that choice.
--
-- Until now the database decided for them, quietly: the company stamped on
-- the login by an admin, else whichever company they were added to FIRST.
-- Nothing on screen said which, and nothing on screen could change it. For
-- a practice whose staff serve several clients, that is how a document ends
-- up in the wrong client's books.
--
-- Now: a per-person choice, written only through set_current_company(),
-- which checks membership; current_company_id() prefers it; and when a
-- person belongs to several companies and has not chosen, the answer is
-- NULL — they see nothing until they choose, rather than someone's books
-- picked by accident of ordering.

-- 1) a name to show in the picker (falls back to the slug, then the id)
alter table public.company_config
  add column if not exists company_name text;
comment on column public.company_config.company_name is
  'What the company switcher shows. When null, company_slug, then the id.';

-- 2) the choice
create table if not exists public.user_company_selection (
  user_id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references public.company_config (company_id) on delete cascade,
  updated_at timestamptz not null default now()
);
comment on table public.user_company_selection is
  'Which company each person is working in. Written only by set_current_company().';

alter table public.user_company_selection enable row level security;

-- A person may read their own choice. Nobody writes the table directly:
-- the function below is the only way in, and it checks membership.
create policy "user_company_selection_select_own"
  on public.user_company_selection for select to authenticated
  using (user_id = auth.uid());

grant select on public.user_company_selection to authenticated;
grant select, insert, update, delete on public.user_company_selection to service_role;

-- 3) choosing
create or replace function public.set_current_company(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  if not exists (
    select 1 from public.company_members m
    where m.user_id = auth.uid() and m.company_id = p_company_id
  ) then
    -- Not a member. "Not found", as the edge guard answers: a refusal must
    -- not confirm that the company exists.
    raise exception 'Not found';
  end if;
  insert into public.user_company_selection (user_id, company_id)
  values (auth.uid(), p_company_id)
  on conflict (user_id) do update
    set company_id = excluded.company_id, updated_at = now();
  return p_company_id;
end;
$$;

revoke all on function public.set_current_company(uuid) from public;
grant execute on function public.set_current_company(uuid) to authenticated;

-- 4) what the picker lists: the caller's companies, named, with the current one flagged.
--    company_config itself is only readable for the current company, so the
--    names come through here rather than from the table.
create or replace function public.my_companies()
returns table (company_id uuid, company_name text, role text, current boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.company_id,
    coalesce(c.company_name, c.company_slug, left(m.company_id::text, 8)) as company_name,
    m.role,
    (m.company_id = public.current_company_id()) as current
  from public.company_members m
  join public.company_config c on c.company_id = m.company_id
  where m.user_id = auth.uid()
  order by 2;
$$;

revoke all on function public.my_companies() from public;
grant execute on function public.my_companies() to authenticated;

-- 5) the answer everything else reads
--    choice (if still a member) -> the login stamp -> the only membership -> NULL.
--    The "oldest membership" fallback is gone on purpose.
create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select s.company_id
      from public.user_company_selection s
      join public.company_members m
        on m.user_id = s.user_id and m.company_id = s.company_id
      where s.user_id = auth.uid()
    ),
    nullif(auth.jwt() -> 'app_metadata' ->> 'company_id', '')::uuid,
    (
      select m.company_id
      from public.company_members m
      where m.user_id = auth.uid()
        and (select count(*) from public.company_members x where x.user_id = auth.uid()) = 1
    )
  );
$$;
