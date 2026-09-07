# Putting this on a hosted Supabase project

Nothing is hosted yet. This is the list for the day it is, written so that
the person doing it does not have to remember what the code assumes. Every
step below is something the code or the audit found the hard way; the order
matters in two places, and both are marked.

## 1. Project and link

Create the Supabase project (pick the region the practice's data must live
in — that choice is permanent), then from this repo:

```
npx supabase login
npx supabase link --project-ref <ref>
```

## 2. Database — migrations, in order, from empty

```
npx supabase db push
```

This applies every file in `supabase/migrations/` from the first. The chain
is self-contained: it creates the single-row Zoho token cache early on and
drops it again at the end (`20260906180000_drop_zoho_oauth_tokens.sql`), so
no manual step is needed between migrations. If `db push` stops partway,
fix the cause and run it again; it resumes from the first unapplied file.

What the chain leaves you with, and what to check:

- 33 tables, every one with row-level security on. `select count(*) from
  pg_tables where schemaname = 'public' and not rowsecurity;` must be 0.
- The `invoices` storage bucket **private**. The migration that makes it so
  raises if it is still public; if `db push` succeeds, it is private.
- Vault enabled (the per-company Zoho refresh token lives there). The
  `zoho_refresh_token` and `zoho_connect` functions are granted to
  `service_role` only.

## 3. Secrets — before any function is deployed

Edge functions read these from the project's secrets, never from a file:

```
npx supabase secrets set \
  ALLOWED_ORIGIN=https://<the app's address, no trailing slash> \
  ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... \
  ZOHO_API_BASE_URL=https://www.zohoapis.ae/books/v3 \
  MINDEE_API_KEY=... MINDEE_MODEL_ID=... \
  GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.6-flash \
  OPENAI_API_KEY=... TRIAGE_LLM_MODEL=gpt-4o-mini \
  INBOUND_EMAIL_DOMAIN=... MAILGUN_SIGNING_KEY=...
```

Three of these deserve a sentence each.

**`ALLOWED_ORIGIN`** is the website allowed to call the functions from a
browser. Unset on a hosted project, the functions answer *no* origin and
the app cannot read a single response — deliberately. It is one address;
if the app ever has two (a preview and production), `_shared/cors.ts` needs
to echo the request's origin against a list, a small change in one file.

**`MAILGUN_WEBHOOK_SKIP_VERIFY`** must not be set. It turns off the check
that an inbound email really came from Mailgun. It exists for one local
accuracy script and nothing else.

**`ZOHO_REFRESH_TOKEN` and `ZOHO_ORGANIZATION_ID`** are not read by
anything any more. Each company's organisation and token are connected per
company in step 5. Setting them does nothing.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
provided to functions automatically on a hosted project.

## 4. Functions

```
npx supabase functions deploy
npx supabase functions deploy inbound-email --no-verify-jwt
```

Each function deploys as its `index.ts` plus everything that file imports:
the modules beside it in its own directory, everything under `_shared/`,
and in a few places a module from another function's directory
(`zoho-approve` uses `zoho-push/mapping.ts`, `cashflow/cash.ts` and
`month-end/schedules.ts`; `cashflow` uses `bank-statement/suggest.ts`;
`bank-statement` uses `bookkeeping-learn/bank_patterns.ts`). So a change to
any file under `_shared/`, or to one of those cross-used modules, is a
change to every function that imports it. Deploy them all — the bare
`functions deploy` above does — rather than only the one you edited.
"What is where" below says which files those are.

Every function verifies the caller itself (`_shared/require_user.ts`), so
the gateway's JWT check is redundant but harmless — except for
`inbound-email`, which Mailgun calls with an HMAC signature and no JWT. It
must be deployed with `--no-verify-jwt` or every inbound email is refused
at the gateway before the function sees it.

Then type-check what was deployed, from the same commit:

```
npm run typecheck:functions      # must say: All functions type-check.
```

## What is where

Since 7 September the three longest functions are a handler (`index.ts`)
beside modules named for what they hold. When something needs changing,
this is where to look — and, per the note in step 4, which other
functions to redeploy with it.

**`_shared/`** — imported by every function.

| File | Holds |
|---|---|
| `require_user.ts` | who is calling: a real user token, or the service role for sibling calls |
| `tenant.ts` | which company that caller may act on — membership decides; 404, never 403 |
| `cors.ts` | which website may call the functions from a browser (`ALLOWED_ORIGIN`) |
| `zoho_auth.ts` | a company's Zoho organisation and access token, refreshed from Vault |
| `zoho_meter.ts` | the API-usage log every Zoho call goes through |
| `bytes.ts` | a byte array `Blob` will accept |

**`zoho-approve/`** — approve a document and post it to Zoho Books.

| File | Holds |
|---|---|
| `index.ts` | the request path: sign-in, whose invoice, guards, the bill / invoice / expense branches |
| `types.ts` | what the review UI sends, what it gets back, the reconciliation outcome |
| `zoho_client.ts` | the metered fetch, the token, retry-once-on-auth-failure, create and apply-credits calls |
| `money.ts` | VAT → `tax_id`, currency → `currency_id`, do the lines add up, which emirate for place of supply |
| `documents.ts` | the source document's bytes, and attaching them to the Zoho record |
| `entities.ts` | synced vendors and accounts, per-party default accounts |
| `audit.ts` | the audit row and the document's status |
| `einvoice.ts` | UAE e-invoice field readiness (informs, never issues) |

**`zoho-push/`** — the system-side push (scripts and siblings; accepts the service role).

| File | Holds |
|---|---|
| `index.ts` | the request path, with bill / invoice / expense branches |
| `types.ts` | what the request carries |
| `zoho_client.ts` | every create / attach / lookup call this function makes to Zoho |
| `bill_body.ts` | the bill as Zoho's create call takes it |
| `money.ts` | the per-party default account; currency and VAT → Zoho ids |
| `documents.ts` | the source document's bytes |
| `guards.ts` | a human approved it, every judgment passed, is the file attached |
| `mapping.ts` | extracted fields → the mapped bill (used by `zoho-approve` too) |
| `match-entities.ts` | matching vendor and accounts against the synced masters |

**`bookkeeping-learn/`** — reads a company's Zoho history and proposes rules.

| File | Holds |
|---|---|
| `index.ts` | the request path: read documents, analyse, read bank transactions |
| `types.ts` | what the Rules screen sends |
| `zoho_history.ts` | the token, a GET with gentle backoff, listing document ids, Zoho payload → `HistoryDoc` |
| `bank_history.ts` | bank transactions: caching them per account, cached history → bank observations |
| `analyze`, `recurrence`, `timing`, `attachments`, `tags_projects`, `journal_patterns`, `bank_patterns` | the analysis layers, separate since before the split |

**`apps/web/src/components/review/`** — not a function; built into the web app.

| File | Holds |
|---|---|
| `model.ts` | an editable line, how reporting tags apply, the UAE VAT treatments |
| `RecordSection.tsx` | "The record": vendor, number, dates, currency, total |
| `TaxSection.tsx` | "Tax": VAT amount and treatment |
| `LinesSection.tsx` | "Lines": the editable line grid and its footer arithmetic |

`ReviewPanel.tsx` keeps the state, the effects, the handlers and the Posting section.

`npm run typecheck:functions` checks each function's `index.ts` and, through it, every module it imports — sibling and shared alike — so a broken sibling module fails the check under the function that uses it.

## 5. Connect each company to its Zoho organisation

Per company, once:

```
node scripts/zoho-connect.mjs    # see the header of the script for arguments
```

This writes the company's organisation id to `zoho_connections` and its
refresh token into Vault. Until it has run for a company, every Zoho action
for that company fails with "not connected" — that is the intended state
for a company that has not been connected, not a fault.

## 6. The web app

Build with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` pointing at the
project. Host it at the address given as `ALLOWED_ORIGIN` — the two must
match exactly, scheme and host, or the browser blocks every call.

## 7. Prove it, the same way it is proved locally

Copy `.env` to `.env.hosted`, point `SUPABASE_URL` and the two keys at the
project, and run the isolation suite against it:

```
cp .env .env.hosted   # edit URL + keys; keep the file out of git (it is)
node --test scripts/tenant-isolation.test.mjs
```

The suite creates two throwaway companies and their users, tries every way
from one into the other, and deletes both. It never touches an existing
company. **23 of 23** is the number.

Then two things the suite cannot check:

- Open the app from a browser at `ALLOWED_ORIGIN` and approve one document
  from a test company. The console must show no CORS errors.
- Send one email to a company's inbound address and confirm it arrives as a
  document. If it does not, the first thing to check is step 4's
  `--no-verify-jwt`.

## 8. Backup, and a restore you have actually done

Hosted projects take daily backups on paid plans. A backup that has never
been restored is a hope, not a backup: restore one into a scratch project
before the first client's data is in, time it, and write the time down here.

Restore drill: _not yet done_.

## Order that matters

- Secrets (3) before functions (4): a function that starts without
  `ALLOWED_ORIGIN` answers no origin until it is redeployed or restarted.
- Migrations (2) before the connect script (5): the script writes into
  tables the migrations create.
