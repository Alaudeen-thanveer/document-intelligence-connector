# Security baseline (local + pilot)

Companion to Situation A/B guidance and BUILD_PLAN secrets rules.

## For teammates pulling this branch (Thanveer / Mina)

After `git pull` / merging into your branch from `staging`:

1. **Docker Desktop on**, then from repo root:
   ```powershell
   npx supabase start
   npx supabase db reset
   npx supabase functions serve --env-file .env
   npm run web:dev
   ```
   (`db reset` applies all migrations, including company_members + private storage.)

2. **Env files** — copy from examples if needed; never commit real secrets:
   - Root `.env` — Mindee, Gemini, Zoho, Supabase local keys from `npx supabase status`
   - `apps/web/.env` — `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_FUNCTIONS_URL`

3. **Create a local Auth user** in Studio http://127.0.0.1:54323 → Authentication → Users  
   (email/password). After `db reset`, the migration seeds existing users onto the default company; if you create the user *after* reset, run the SQL below.

4. **Sign out / sign in** on http://localhost:5173 so JWT picks up `app_metadata.company_id`.

5. Confirm JWT has company_id (DevTools → Local Storage → `sb-127-auth-token` → `user.app_metadata.company_id`).

Manual seed if needed (replace `USER_UUID`):

```sql
insert into public.company_members (user_id, company_id, role)
values (
  'USER_UUID',
  '00000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict do nothing;

update auth.users
set raw_app_meta_data =
  coalesce(raw_app_meta_data, '{}'::jsonb)
  || '{"company_id":"00000000-0000-4000-8000-000000000001"}'::jsonb
where id = 'USER_UUID';
```

Then sign out/in again.

### Demo scripts and the bank statement flow

- `scripts/demo/reset-demo.mjs` calls human-only edges (learner, judgment), so it signs in as a local Auth user: set `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` in the root `.env` (a user created as above, who is a company member). Never commit credentials.
- The `bank-statement` edge is human-only for `suggest` / `confirm` / `push` / `party_credits`. `ingest` additionally accepts the service role **only** with `source: "email"` — the mailbox pipeline's machine-to-machine path. Browser callers always need a user session.
- Bank tables (`bk_bank_patterns`, `bank_statements`, `bank_statement_lines`) follow the company-scoped model (`current_company_id()`), no anon access — see migration `20260817180000_bank_tables_company_rls.sql`.

## Situation A — local guardrails (ops, always)

- Local Supabase only on `127.0.0.1` / `localhost` — **no** ngrok/public tunnel to the DB or Studio.
- Seed **fake / synthetic** documents only — never real client PDFs in local Docker.
- Keep `.env` git-ignored. Local keys ≠ production keys.
- Production / shared cloud project must use freshly generated keys.

## Situation B — done in code

- UI requires Supabase Auth sign-in.
- Human-triggered edge functions require a **user JWT** (not the anon key).
- `inbound-email` uses Mailgun signature; sibling calls may use `service_role`.

## Membership + RLS + private storage

- Table `company_members` links `auth.users` → `company_config`.
- JWT claim: `app_metadata.company_id` (admin-set). Migration seeds existing local users onto the default company.
- Document child tables, account rules, and `zoho_entities` are company-scoped.
- `invoices` bucket is **private**. New uploads store `storage://invoices/{company_id}/…`. UI opens files via **signed URLs**.

## Still later

- Multi-company UI (pick company).
- Retention policy enforcement.
- Hosted secrets on Vercel / Supabase (never in git).
