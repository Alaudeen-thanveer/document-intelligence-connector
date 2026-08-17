-- Situation B follow-up: company membership, child-table RLS, private storage.
--
-- 1) company_members — source of truth for which users belong to which company
-- 2) current_company_id() — JWT app_metadata, else single membership row
-- 3) Tighten remaining POC policies (document children, rules, zoho_entities)
-- 4) invoices bucket private; objects keyed as {company_id}/{filename}

-- ---------------------------------------------------------------------------
-- company_members
-- ---------------------------------------------------------------------------
create table if not exists public.company_members (
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references public.company_config (company_id) on delete cascade,
  role text not null default 'reviewer'
    check (role in ('owner', 'admin', 'reviewer')),
  created_at timestamptz not null default now(),
  primary key (user_id, company_id)
);

create index if not exists company_members_company_id_idx
  on public.company_members (company_id);

alter table public.company_members enable row level security;

create policy "company_members_select_own"
  on public.company_members for select to authenticated
  using (user_id = auth.uid());

-- Membership writes are admin/service only (Studio SQL or service_role).
revoke all on table public.company_members from anon, public;
grant select on table public.company_members to authenticated;
grant select, insert, update, delete on table public.company_members to service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(auth.jwt() -> 'app_metadata' ->> 'company_id', '')::uuid,
    (
      select m.company_id
      from public.company_members m
      where m.user_id = auth.uid()
      order by m.created_at asc
      limit 1
    )
  );
$$;

revoke all on function public.current_company_id() from public;
grant execute on function public.current_company_id() to authenticated;

create or replace function public.user_in_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_company_id is not null
    and (
      p_company_id = public.current_company_id()
      or exists (
        select 1
        from public.company_members m
        where m.user_id = auth.uid()
          and m.company_id = p_company_id
      )
    );
$$;

revoke all on function public.user_in_company(uuid) from public;
grant execute on function public.user_in_company(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Document child tables (no company_id column — join through documents)
-- ---------------------------------------------------------------------------
drop policy if exists "extracted_fields_select_poc" on public.extracted_fields;
drop policy if exists "extracted_fields_update_poc" on public.extracted_fields;
drop policy if exists "extracted_fields_insert_poc" on public.extracted_fields;

create policy "extracted_fields_select_company"
  on public.extracted_fields for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = extracted_fields.document_id
        and public.user_in_company(d.company_id)
    )
  );
create policy "extracted_fields_insert_company"
  on public.extracted_fields for insert to authenticated
  with check (
    exists (
      select 1 from public.documents d
      where d.id = extracted_fields.document_id
        and public.user_in_company(d.company_id)
    )
  );
create policy "extracted_fields_update_company"
  on public.extracted_fields for update to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = extracted_fields.document_id
        and public.user_in_company(d.company_id)
    )
  )
  with check (
    exists (
      select 1 from public.documents d
      where d.id = extracted_fields.document_id
        and public.user_in_company(d.company_id)
    )
  );

revoke all on table public.extracted_fields from anon, public;
grant select, insert, update on table public.extracted_fields to authenticated;

drop policy if exists "extracted_line_items_poc" on public.extracted_line_items;

create policy "extracted_line_items_select_company"
  on public.extracted_line_items for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = extracted_line_items.document_id
        and public.user_in_company(d.company_id)
    )
  );
create policy "extracted_line_items_write_company"
  on public.extracted_line_items for all to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = extracted_line_items.document_id
        and public.user_in_company(d.company_id)
    )
  )
  with check (
    exists (
      select 1 from public.documents d
      where d.id = extracted_line_items.document_id
        and public.user_in_company(d.company_id)
    )
  );

revoke all on table public.extracted_line_items from anon, public;
grant select, insert, update, delete on table public.extracted_line_items to authenticated;

drop policy if exists "judgment_results_select_poc" on public.judgment_results;
drop policy if exists "judgment_results_update_poc" on public.judgment_results;
drop policy if exists "judgment_results_insert_poc" on public.judgment_results;

create policy "judgment_results_select_company"
  on public.judgment_results for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = judgment_results.document_id
        and public.user_in_company(d.company_id)
    )
  );
create policy "judgment_results_insert_company"
  on public.judgment_results for insert to authenticated
  with check (
    exists (
      select 1 from public.documents d
      where d.id = judgment_results.document_id
        and public.user_in_company(d.company_id)
    )
  );
create policy "judgment_results_update_company"
  on public.judgment_results for update to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = judgment_results.document_id
        and public.user_in_company(d.company_id)
    )
  )
  with check (
    exists (
      select 1 from public.documents d
      where d.id = judgment_results.document_id
        and public.user_in_company(d.company_id)
    )
  );

revoke all on table public.judgment_results from anon, public;
grant select, insert, update on table public.judgment_results to authenticated;

drop policy if exists "erp_sync_log_select_poc" on public.erp_sync_log;

create policy "erp_sync_log_select_company"
  on public.erp_sync_log for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = erp_sync_log.document_id
        and public.user_in_company(d.company_id)
    )
  );

revoke all on table public.erp_sync_log from anon, public;
grant select on table public.erp_sync_log to authenticated;

-- ---------------------------------------------------------------------------
-- vendor_account_rules / customer_account_rules — add company_id
-- ---------------------------------------------------------------------------
alter table public.vendor_account_rules
  add column if not exists company_id uuid
    references public.company_config (company_id);

update public.vendor_account_rules
set company_id = '00000000-0000-4000-8000-000000000001'
where company_id is null;

alter table public.vendor_account_rules
  alter column company_id set default '00000000-0000-4000-8000-000000000001',
  alter column company_id set not null;

alter table public.vendor_account_rules
  drop constraint if exists vendor_account_rules_vendor_zoho_id_key;

alter table public.vendor_account_rules
  drop constraint if exists vendor_account_rules_company_vendor_unique;

alter table public.vendor_account_rules
  add constraint vendor_account_rules_company_vendor_unique
  unique (company_id, vendor_zoho_id);

drop policy if exists "vendor_account_rules_select_poc" on public.vendor_account_rules;
drop policy if exists "vendor_account_rules_insert_poc" on public.vendor_account_rules;
drop policy if exists "vendor_account_rules_update_poc" on public.vendor_account_rules;
drop policy if exists "vendor_account_rules_delete_poc" on public.vendor_account_rules;

create policy "vendor_account_rules_select_company"
  on public.vendor_account_rules for select to authenticated
  using (public.user_in_company(company_id));
create policy "vendor_account_rules_insert_company"
  on public.vendor_account_rules for insert to authenticated
  with check (public.user_in_company(company_id));
create policy "vendor_account_rules_update_company"
  on public.vendor_account_rules for update to authenticated
  using (public.user_in_company(company_id))
  with check (public.user_in_company(company_id));
create policy "vendor_account_rules_delete_company"
  on public.vendor_account_rules for delete to authenticated
  using (public.user_in_company(company_id));

revoke all on table public.vendor_account_rules from anon, public;
grant select, insert, update, delete on table public.vendor_account_rules to authenticated;

alter table public.customer_account_rules
  add column if not exists company_id uuid
    references public.company_config (company_id);

update public.customer_account_rules
set company_id = '00000000-0000-4000-8000-000000000001'
where company_id is null;

alter table public.customer_account_rules
  alter column company_id set default '00000000-0000-4000-8000-000000000001',
  alter column company_id set not null;

alter table public.customer_account_rules
  drop constraint if exists customer_account_rules_customer_zoho_id_key;

alter table public.customer_account_rules
  drop constraint if exists customer_account_rules_company_customer_unique;

alter table public.customer_account_rules
  add constraint customer_account_rules_company_customer_unique
  unique (company_id, customer_zoho_id);

drop policy if exists "customer_account_rules_select_poc" on public.customer_account_rules;
drop policy if exists "customer_account_rules_insert_poc" on public.customer_account_rules;
drop policy if exists "customer_account_rules_update_poc" on public.customer_account_rules;
drop policy if exists "customer_account_rules_delete_poc" on public.customer_account_rules;

create policy "customer_account_rules_select_company"
  on public.customer_account_rules for select to authenticated
  using (public.user_in_company(company_id));
create policy "customer_account_rules_insert_company"
  on public.customer_account_rules for insert to authenticated
  with check (public.user_in_company(company_id));
create policy "customer_account_rules_update_company"
  on public.customer_account_rules for update to authenticated
  using (public.user_in_company(company_id))
  with check (public.user_in_company(company_id));
create policy "customer_account_rules_delete_company"
  on public.customer_account_rules for delete to authenticated
  using (public.user_in_company(company_id));

revoke all on table public.customer_account_rules from anon, public;
grant select, insert, update, delete on table public.customer_account_rules to authenticated;

-- ---------------------------------------------------------------------------
-- zoho_entities — add company_id
-- ---------------------------------------------------------------------------
alter table public.zoho_entities
  add column if not exists company_id uuid
    references public.company_config (company_id);

update public.zoho_entities
set company_id = '00000000-0000-4000-8000-000000000001'
where company_id is null;

alter table public.zoho_entities
  alter column company_id set default '00000000-0000-4000-8000-000000000001',
  alter column company_id set not null;

alter table public.zoho_entities
  drop constraint if exists zoho_entities_kind_zoho_id_key;

alter table public.zoho_entities
  drop constraint if exists zoho_entities_company_kind_zoho_unique;

alter table public.zoho_entities
  add constraint zoho_entities_company_kind_zoho_unique
  unique (company_id, kind, zoho_id);

drop policy if exists "zoho_entities_select_poc" on public.zoho_entities;

create policy "zoho_entities_select_company"
  on public.zoho_entities for select to authenticated
  using (public.user_in_company(company_id));

revoke all on table public.zoho_entities from anon, public;
grant select on table public.zoho_entities to authenticated;

-- ---------------------------------------------------------------------------
-- Strengthen documents policies to accept membership as well as JWT claim
-- ---------------------------------------------------------------------------
drop policy if exists "documents_select_company" on public.documents;
drop policy if exists "documents_insert_company" on public.documents;
drop policy if exists "documents_update_company" on public.documents;

create policy "documents_select_company"
  on public.documents for select to authenticated
  using (public.user_in_company(company_id));
create policy "documents_insert_company"
  on public.documents for insert to authenticated
  with check (public.user_in_company(company_id));
create policy "documents_update_company"
  on public.documents for update to authenticated
  using (public.user_in_company(company_id))
  with check (public.user_in_company(company_id));

-- ---------------------------------------------------------------------------
-- Private invoices storage bucket
-- ---------------------------------------------------------------------------
update storage.buckets
set public = false
where id = 'invoices';

drop policy if exists "invoices_objects_select_poc" on storage.objects;
drop policy if exists "invoices_objects_insert_poc" on storage.objects;
drop policy if exists "invoices_objects_update_poc" on storage.objects;

-- Object name format: {company_id}/{uuid}-{filename}
create policy "invoices_objects_select_company"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'invoices'
    and public.user_in_company( (split_part(name, '/', 1))::uuid )
  );

create policy "invoices_objects_insert_company"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'invoices'
    and public.user_in_company( (split_part(name, '/', 1))::uuid )
  );

create policy "invoices_objects_update_company"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'invoices'
    and public.user_in_company( (split_part(name, '/', 1))::uuid )
  )
  with check (
    bucket_id = 'invoices'
    and public.user_in_company( (split_part(name, '/', 1))::uuid )
  );

-- ---------------------------------------------------------------------------
-- Local seed helper: attach ALL existing auth users to the default company
-- and stamp app_metadata.company_id so JWT + zoho-approve work after re-login.
-- Safe for local POC only (single-tenant default company).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  default_company uuid := '00000000-0000-4000-8000-000000000001';
begin
  for r in select id from auth.users loop
    insert into public.company_members (user_id, company_id, role)
    values (r.id, default_company, 'owner')
    on conflict (user_id, company_id) do nothing;

    update auth.users
    set raw_app_meta_data =
      coalesce(raw_app_meta_data, '{}'::jsonb)
      || jsonb_build_object('company_id', default_company::text)
    where id = r.id;
  end loop;
end $$;
