-- Per-company extraction config. company_id required on company-data tables.
create table public.company_config (
  company_id uuid primary key default gen_random_uuid(),
  extraction_confidence_threshold numeric not null default 0.8
    check (
      extraction_confidence_threshold >= 0
      and extraction_confidence_threshold <= 1
    ),
  created_at timestamptz not null default now()
);

alter table public.company_config enable row level security;

create policy "company_config_select_poc"
  on public.company_config for select
  to anon, authenticated
  using (true);

grant select on table public.company_config to anon, authenticated;

-- Default single-tenant company for local/POC
insert into public.company_config (company_id, extraction_confidence_threshold)
values ('00000000-0000-4000-8000-000000000001', 0.8);

-- Attach documents to a company so extract can load the threshold
alter table public.documents
  add column if not exists company_id uuid
    references public.company_config (company_id);

update public.documents
set company_id = '00000000-0000-4000-8000-000000000001'
where company_id is null;

alter table public.documents
  alter column company_id set default '00000000-0000-4000-8000-000000000001';

alter table public.documents
  alter column company_id set not null;

create index if not exists documents_company_id_idx
  on public.documents (company_id);
