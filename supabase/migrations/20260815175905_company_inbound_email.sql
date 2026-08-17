-- Per-company inbound mailbox (no Gmail/Outlook OAuth).
-- Address format: {company-slug}-{random}@INBOUND_EMAIL_DOMAIN
alter table public.company_config
  add column if not exists company_slug text,
  add column if not exists inbound_local_part text,
  add column if not exists inbound_email text;

comment on column public.company_config.company_slug is
  'URL-safe slug used in the inbound mailbox local-part';
comment on column public.company_config.inbound_local_part is
  'Local part before @, e.g. acme-x7k2ab';
comment on column public.company_config.inbound_email is
  'Full inbound address, e.g. acme-x7k2ab@in.ourapp.com';

-- Unique when set (multiple nulls allowed until backfilled)
create unique index if not exists company_config_inbound_local_part_uidx
  on public.company_config (inbound_local_part)
  where inbound_local_part is not null;

create unique index if not exists company_config_inbound_email_uidx
  on public.company_config (inbound_email)
  where inbound_email is not null;

create index if not exists company_config_inbound_email_lookup_idx
  on public.company_config (lower(inbound_email));

-- Assign a stable POC mailbox so local accuracy tests have a known address.
-- Domain matches INBOUND_EMAIL_DOMAIN in .env.example (in.ourapp.com).
update public.company_config
set
  company_slug = coalesce(nullif(company_slug, ''), 'poc'),
  inbound_local_part = coalesce(nullif(inbound_local_part, ''), 'poc-a1b2c3d4'),
  inbound_email = coalesce(
    nullif(inbound_email, ''),
    'poc-a1b2c3d4@in.ourapp.com'
  )
where company_id = '00000000-0000-4000-8000-000000000001';

-- Helper: generate a unique inbound address for a company (call at onboarding).
create or replace function public.assign_inbound_email(
  p_company_id uuid,
  p_slug text,
  p_domain text default 'in.ourapp.com'
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_local text;
  v_email text;
  v_try int := 0;
begin
  v_slug := lower(regexp_replace(trim(p_slug), '[^a-z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from v_slug);
  if v_slug is null or v_slug = '' then
    v_slug := 'company';
  end if;
  v_slug := left(v_slug, 40);

  loop
    v_try := v_try + 1;
    v_local := v_slug || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
    v_email := v_local || '@' || lower(trim(p_domain));
    begin
      update public.company_config
      set
        company_slug = v_slug,
        inbound_local_part = v_local,
        inbound_email = v_email
      where company_id = p_company_id;
      if not found then
        raise exception 'company_config row not found for %', p_company_id;
      end if;
      return v_email;
    exception
      when unique_violation then
        if v_try >= 8 then
          raise;
        end if;
    end;
  end loop;
end;
$$;

revoke all on function public.assign_inbound_email(uuid, text, text) from public;
grant execute on function public.assign_inbound_email(uuid, text, text) to service_role;
