-- Append-only audit trail. Insert-only: no updated_at, and no UPDATE/DELETE
-- policies or grants. Even a buggy client or service-role call cannot rewrite
-- or erase a row. Extra context (rule that fired, Zoho payload) goes in detail.
--
-- SELECT is company-scoped the same way Phase 2 attached documents to
-- company_config: a caller can only read rows whose company_id they can
-- already see on company_config. INSERT is service_role only.

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company_config (company_id),
  invoice_id uuid references public.documents (id) on delete set null,
  actor_type text not null check (actor_type in ('system', 'human')),
  actor_id uuid,
  action text not null,
  -- e.g. extracted | validated | approved | rejected | zoho_synced | zoho_sync_failed
  detail jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_company_invoice_created_idx
  on public.audit_log (company_id, invoice_id, created_at);

alter table public.audit_log enable row level security;

-- Dashboard / API reads, scoped to companies the role can already see.
create policy "audit_log_select_company"
  on public.audit_log for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.company_config c
      where c.company_id = audit_log.company_id
    )
  );

-- No UPDATE or DELETE policies — RLS denies those to anon/authenticated.

grant select on table public.audit_log to anon, authenticated;
grant select, insert on table public.audit_log to service_role;

revoke update, delete on table public.audit_log from anon, authenticated, service_role;
