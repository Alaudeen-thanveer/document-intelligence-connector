-- An append-only record of every approval decision.
--
-- Approvals were recorded only as the current state of the rows they changed:
-- documents.status, judgment_results.passed, a line's status, a proposal's
-- status. Change the row and the history is gone. The "who" was a name the
-- browser typed (reviewed_by, decided_by, ready_by). And audit_log, the one
-- append-only table, was writable by any signed-in user, who could insert rows
-- claiming any actor.
--
-- approval_events is written by the database itself, from triggers on the
-- tables where approvals happen, so no code path — browser, edge function or
-- script — can make an approval without leaving a row, and none can supply
-- the row's contents. The actor is the authenticated user id from the
-- request's JWT (auth.uid()), not a typed name; the typed name is kept beside
-- it, labelled as self-reported.
--
-- Append-only is enforced three ways:
--   - no role holds INSERT, UPDATE, DELETE or TRUNCATE on the table;
--   - triggers refuse UPDATE, DELETE and TRUNCATE for every role, the owner
--     and service_role included;
--   - rows are hash-chained per company, so a row altered or removed out of
--     band (with triggers disabled by a superuser) breaks the chain, which
--     approval_events_verify() reports.
--
-- What counts as an approval event:
--   documents            status changes, Zoho record linked, deletion
--   judgment_results     a failed check marked passed (override), a passed
--                        check re-failed, a human review approval recorded
--   bank_statement_lines status changes (confirmed / skipped / posted …)
--   bk_journal_proposals, bk_asset_proposals, bk_schedules,
--   bk_check_proposals, bk_journal_patterns          status changes
--   bk_party_profiles, bk_party_tag_profiles, bk_party_project_profiles,
--   bk_account_tag_profiles, bk_bank_patterns        suggestion_status changes

-- ---------------------------------------------------------------------------
-- 1) the table
-- ---------------------------------------------------------------------------
create table if not exists public.approval_events (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  occurred_at timestamptz not null default clock_timestamp(),
  subject_table text not null,
  subject_id text not null,
  document_id uuid,
  action text not null,
  from_state text,
  to_state text,
  -- Who, from the verified JWT. Null when the database was changed by the
  -- service role or a direct connection rather than a signed-in person.
  actor_user_id uuid,
  actor_email text,
  actor_role text not null,
  -- The name the client typed (reviewed_by / decided_by / ready_by). Not
  -- verified; kept because reviewers recognise it.
  actor_label_self_reported text,
  detail jsonb,
  prev_hash bytea,
  row_hash bytea not null
);

create index if not exists approval_events_company_time_idx
  on public.approval_events (company_id, occurred_at desc);
create index if not exists approval_events_document_idx
  on public.approval_events (document_id) where document_id is not null;

comment on table public.approval_events is
  'Append-only, hash-chained record of approval decisions, written only by database triggers. Actor comes from auth.uid(). No role may insert, update, delete or truncate.';

alter table public.approval_events enable row level security;

drop policy if exists "approval_events_select_company" on public.approval_events;
create policy "approval_events_select_company"
  on public.approval_events for select to authenticated
  using (public.user_in_company(company_id));

revoke all on table public.approval_events from public, anon, authenticated, service_role;
grant select on table public.approval_events to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) append-only, for everyone
-- ---------------------------------------------------------------------------
create or replace function public.refuse_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists approval_events_no_update_delete on public.approval_events;
create trigger approval_events_no_update_delete
  before update or delete on public.approval_events
  for each row execute function public.refuse_audit_mutation();

drop trigger if exists approval_events_no_truncate on public.approval_events;
create trigger approval_events_no_truncate
  before truncate on public.approval_events
  for each statement execute function public.refuse_audit_mutation();

-- audit_log was append-only by grant alone, and browser-insertable. Nothing
-- in the browser writes it; edge functions write it with the service role.
revoke insert, update, delete, truncate on table public.audit_log from anon, authenticated;
drop policy if exists "audit_log_insert_company" on public.audit_log;

drop trigger if exists audit_log_no_update_delete on public.audit_log;
create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function public.refuse_audit_mutation();

drop trigger if exists audit_log_no_truncate on public.audit_log;
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.refuse_audit_mutation();

-- ---------------------------------------------------------------------------
-- 3) writing an event (trigger-only; not callable over the API)
-- ---------------------------------------------------------------------------
create or replace function public.approval_event_append(
  p_company_id uuid,
  p_subject_table text,
  p_subject_id text,
  p_document_id uuid,
  p_action text,
  p_from text,
  p_to text,
  p_label text,
  p_detail jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_user uuid := nullif(v_claims ->> 'sub', '')::uuid;
  v_email text := v_claims ->> 'email';
  v_role text := coalesce(v_claims ->> 'role', session_user::text);
  v_at timestamptz := clock_timestamp();
  v_prev bytea;
  v_hash bytea;
begin
  if p_company_id is null then
    -- An approval that cannot be attributed to a company is still recorded.
    p_company_id := '00000000-0000-0000-0000-000000000000';
  end if;
  if v_role = 'service_role' or v_role = 'anon' then
    v_user := null;
    v_email := null;
  end if;

  -- One writer per company at a time, so the chain cannot fork.
  perform pg_advisory_xact_lock(hashtextextended('approval_events:' || p_company_id::text, 0));

  select e.row_hash into v_prev
  from public.approval_events e
  where e.company_id = p_company_id
  order by e.id desc
  limit 1;

  v_hash := sha256(
    coalesce(v_prev, '\x'::bytea) ||
    convert_to(
      concat_ws('|',
        p_company_id::text, to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), p_subject_table, p_subject_id,
        coalesce(p_document_id::text, ''), p_action, coalesce(p_from, ''), coalesce(p_to, ''),
        coalesce(v_user::text, ''), coalesce(v_email, ''), v_role, coalesce(p_label, ''),
        coalesce(p_detail::text, '')
      ),
      'UTF8'
    )
  );

  insert into public.approval_events (
    company_id, occurred_at, subject_table, subject_id, document_id, action,
    from_state, to_state, actor_user_id, actor_email, actor_role,
    actor_label_self_reported, detail, prev_hash, row_hash
  ) values (
    p_company_id, v_at, p_subject_table, p_subject_id, p_document_id, p_action,
    p_from, p_to, v_user, v_email, v_role, p_label, p_detail, v_prev, v_hash
  );
end;
$$;

revoke all on function public.approval_event_append(uuid, text, text, uuid, text, text, text, text, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) the triggers
-- ---------------------------------------------------------------------------
create or replace function public.approval_events_on_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.approval_event_append(
      old.company_id, 'documents', old.id::text, old.id, 'document_deleted',
      old.status, null, null,
      jsonb_build_object('zoho_bill_id', old.zoho_bill_id));
    return old;
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.status is distinct from old.status then
    perform public.approval_event_append(
      new.company_id, 'documents', new.id::text, new.id, 'document_status_changed',
      old.status, new.status, new.ready_by, null);
  end if;
  if new.zoho_bill_id is distinct from old.zoho_bill_id then
    perform public.approval_event_append(
      new.company_id, 'documents', new.id::text, new.id, 'zoho_record_linked',
      old.zoho_bill_id, new.zoho_bill_id, new.ready_by, null);
  end if;
  if new.ready_at is distinct from old.ready_at then
    perform public.approval_event_append(
      new.company_id, 'documents', new.id::text, new.id,
      case when new.ready_at is null then 'marked_not_ready' else 'marked_ready' end,
      old.ready_at::text, new.ready_at::text, new.ready_by, null);
  end if;
  return new;
end;
$$;

create or replace function public.approval_events_on_judgment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  select d.company_id into v_company from public.documents d where d.id = new.document_id;

  if tg_op = 'INSERT' then
    if new.reviewed_by is not null or new.rule_name = 'human_review_approval' then
      perform public.approval_event_append(
        v_company, 'judgment_results', new.id::text, new.document_id,
        'review_approval_recorded', null, new.passed::text, new.reviewed_by,
        jsonb_build_object('rule_name', new.rule_name, 'notes', new.notes));
    end if;
    return new;
  end if;

  if new.passed is distinct from old.passed then
    perform public.approval_event_append(
      v_company, 'judgment_results', new.id::text, new.document_id,
      case when new.passed then 'check_overridden' else 'check_reinstated' end,
      old.passed::text, new.passed::text, new.reviewed_by,
      jsonb_build_object('rule_name', new.rule_name, 'notes', new.notes));
  end if;
  return new;
end;
$$;

-- Generic: a status-like column on a company-scoped table. TG_ARGV[0] names
-- the column, TG_ARGV[1] the document_id column when there is one.
create or replace function public.approval_events_on_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_col text := tg_argv[0];
  v_doc_col text := nullif(tg_argv[1], '');
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  if (v_new ->> v_col) is distinct from (v_old ->> v_col) then
    perform public.approval_event_append(
      (v_new ->> 'company_id')::uuid,
      tg_table_name,
      v_new ->> 'id',
      case when v_doc_col is null then null else nullif(v_new ->> v_doc_col, '')::uuid end,
      'status_changed',
      v_old ->> v_col,
      v_new ->> v_col,
      v_new ->> 'decided_by',
      jsonb_strip_nulls(jsonb_build_object(
        'decision', v_new ->> 'decision',
        'zoho_id', coalesce(v_new ->> 'zoho_txn_id', v_new ->> 'zoho_journal_id', v_new ->> 'zoho_asset_id'),
        'chosen_txn_kind', v_new ->> 'chosen_txn_kind',
        'amount', v_new -> 'amount'
      )));
  end if;
  return new;
end;
$$;

revoke all on function public.approval_events_on_document() from public, anon, authenticated, service_role;
revoke all on function public.approval_events_on_judgment() from public, anon, authenticated, service_role;
revoke all on function public.approval_events_on_status() from public, anon, authenticated, service_role;

drop trigger if exists approval_events_documents on public.documents;
create trigger approval_events_documents
  after update or delete on public.documents
  for each row execute function public.approval_events_on_document();

drop trigger if exists approval_events_judgment on public.judgment_results;
create trigger approval_events_judgment
  after insert or update on public.judgment_results
  for each row execute function public.approval_events_on_judgment();

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('bank_statement_lines', 'status', ''),
      ('bk_journal_proposals', 'status', ''),
      ('bk_asset_proposals', 'status', 'document_id'),
      ('bk_schedules', 'status', ''),
      ('bk_check_proposals', 'status', ''),
      ('bk_journal_patterns', 'status', ''),
      ('bk_party_profiles', 'suggestion_status', ''),
      ('bk_party_tag_profiles', 'suggestion_status', ''),
      ('bk_party_project_profiles', 'suggestion_status', ''),
      ('bk_account_tag_profiles', 'suggestion_status', ''),
      ('bk_bank_patterns', 'suggestion_status', '')
    ) as t(tbl, col, doc_col)
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = r.col
    ) and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = 'company_id'
    ) and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = 'id'
    ) then
      execute format('drop trigger if exists approval_events_status on public.%I', r.tbl);
      execute format(
        'create trigger approval_events_status after update on public.%I
           for each row execute function public.approval_events_on_status(%L, %L)',
        r.tbl, r.col, r.doc_col);
    else
      raise exception 'approval trigger target %.% is missing', r.tbl, r.col;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5) checking the chain
-- ---------------------------------------------------------------------------
-- The first event whose hash does not follow from the one before it, or no
-- row when the company's chain is intact.
create or replace function public.approval_events_verify(p_company_id uuid)
returns table (broken_at_id bigint, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e record;
  v_prev bytea := null;
  v_expect bytea;
begin
  -- A member of the company, the service role, or a direct database session.
  if coalesce(auth.role(), '') not in ('service_role', '') and not public.user_in_company(p_company_id) then
    raise exception 'Not found';
  end if;
  for e in
    select * from public.approval_events where company_id = p_company_id order by id
  loop
    if e.prev_hash is distinct from v_prev then
      broken_at_id := e.id; reason := 'previous-hash link broken (a row was removed or reordered)';
      return next; return;
    end if;
    v_expect := sha256(
      coalesce(v_prev, '\x'::bytea) ||
      convert_to(
        concat_ws('|',
          e.company_id::text, to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), e.subject_table, e.subject_id,
          coalesce(e.document_id::text, ''), e.action, coalesce(e.from_state, ''), coalesce(e.to_state, ''),
          coalesce(e.actor_user_id::text, ''), coalesce(e.actor_email, ''), e.actor_role,
          coalesce(e.actor_label_self_reported, ''), coalesce(e.detail::text, '')
        ),
        'UTF8'
      )
    );
    if e.row_hash is distinct from v_expect then
      broken_at_id := e.id; reason := 'row contents do not match their hash (a row was altered)';
      return next; return;
    end if;
    v_prev := e.row_hash;
  end loop;
end;
$$;

revoke all on function public.approval_events_verify(uuid) from public, anon;
grant execute on function public.approval_events_verify(uuid) to authenticated, service_role;
