# Document Intelligence Connector — Build Specification

This file is the single source of truth for what this application is, how it's structured, and the exact order in which to build it. Give this file to your AI coding assistant at the start of every session — it should override any assumption the assistant makes on its own.

---

## 1. What this app is

A middleware layer that watches a client's inbound documents (invoices, POs, tax notices), turns them into structured, verified data, and pushes that data into the client's existing accounting system — currently **Zoho**.

**It is not:**
- A bookkeeping app or ERP replacement
- A Zoho Books competitor
- A generic "OCR tool" — extraction is the cheapest part of this product, not the point of it

**What "done" looks like for the POC:**
A single invoice, sent by email, arrives in Zoho as a correctly categorized bill — with a full audit trail showing what was extracted, what checks it passed or failed, and who approved it if it needed a human — without a person manually keying anything in.

---

## 2. Data flow

```
[Email / Drive / OneDrive]
        │  (interval pull, step 1)
        ▼
[Triage: what is this document?]
        │  invoice | PO | tax notice | irrelevant
        ▼
[Extraction: OCR → confidence check]
        │  low confidence field → AI model fallback
        ▼
[Judgment layer: is this data trustworthy?]
        │  rule checks, vendor-history comparison, PO threshold
        ▼
   ┌────┴────┐
 passes     fails
   │           │
   ▼           ▼
[Zoho push]  [Human review queue]
   │           │
   └────┬──────┘
        ▼
[Zoho pull: catch manually-entered records]
        │  runs back through the judgment layer
        ▼
[Audit log — every decision, traceable]
```

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Database + auth | Supabase (Postgres) | Free tier covers POC scale, built-in row-level security |
| Backend logic | Supabase Edge Functions (TypeScript) | No separate server to manage |
| OCR | Mindee (primary) | Dedicated invoice API, confidence scores per field |
| Extraction fallback | Vision-capable LLM call | Only triggered when OCR confidence is below threshold |
| ERP target | Zoho Books API | Current target per product decision |
| Frontend | React + TypeScript | Matches your existing stack |

---

## 4. Repository structure

Keep this exact shape. A reviewer should be able to guess where any piece of logic lives without being told.

```
/supabase
  /migrations              -- one file per schema change, never edit an old one
  /functions
    /triage
    /extract
    /judgment
    /zoho-push
    /zoho-pull
/apps
  /web                      -- React review/approval dashboard
/docs
  /BUILD_PLAN.md            -- this file
  /rules-registry.md        -- plain-language list of every judgment rule, kept in sync with code
/tests
  /judgment                 -- test fixtures: one real (anonymized) document per rule
```

Rule for the coding agent: **never create a file outside this structure without being told where it goes.** If a new component doesn't obviously fit, stop and ask rather than inventing a new top-level folder.

---

## 5. Data-handling rules (non-negotiable)

- No API key, OAuth secret, or credential is ever written into a code file. All secrets live in Supabase's secrets manager / environment variables, and `.env` is git-ignored from the first commit.
- Every table that holds client data has row-level security enabled before it holds a single real row — not added later.
- Raw uploaded documents are only kept as long as needed to extract and verify them, per a retention policy you set explicitly in `/docs`, not left indefinite by default.
- Every read or write to a client's document is logged with who/what triggered it — the `erp_sync_log` and `judgment_results` tables exist partly for this reason.
- Zoho OAuth scopes are requested at the narrowest level that still works — don't request account-wide access if a bills-only scope is available.

---

## 6. Build order

| # | Component | Difficulty | Cost |
|---|---|---|---|
| 1 | Supabase schema | Easy | Free |
| 2 | Triage (document classification) | Easy | Free |
| 3 | Extraction: OCR + confidence-based AI fallback | Medium | Free tier → pay-per-page |
| 4 | Zoho schema mapping (field → field) | Easy | Free |
| 5 | Zoho account/vendor matching (entity resolution) | Medium–Hard | Free (your time) |
| 6 | **Judgment layer (rules engine)** | **Hard** | Free (your time) |
| 7 | Zoho push connector | Medium | Free sandbox |
| 8 | Review/approval UI | Medium | Free |
| 9 | Zoho pull / reconciliation | Medium–Hard | Free |
| 10 | Pilot with 3–5 real bookkeepers | — | Your time |
| 11 | Month-end close support | Hard | Deferred — post-pilot only |
| 12 | Second ERP / SAP | Hard | Client-funded — deferred |

Build strictly in this order. Do not start step *n+1* until step *n* has a passing test in `/tests`.

---

## 7. Step-by-step prompts

Paste each prompt into your coding agent one at a time, in order. Each one names the exact file path it should produce, so output lands in the right place in the structure above.

**Step 1 — Schema**
```
Read /docs/BUILD_PLAN.md for full context before starting.
Create Supabase migrations in /supabase/migrations for these tables:
documents (id, source, file_url, status, uploaded_at)
extracted_fields (id, document_id, doc_type, vendor_raw, total_amount,
  invoice_date, confidence_scores jsonb, raw_ocr_json, ai_fallback_used boolean)
judgment_results (id, document_id, rule_name, passed, notes, reviewed_by)
erp_sync_log (id, document_id, source_type ['push'|'pull'], erp_name,
  external_doc_id, synced_at, judgment_result_id)
Enable row-level security on every table. Add indexes on document_id and status.
Do not create any file outside /supabase/migrations for this step.
```

**Step 2 — Triage**
```
Read /docs/BUILD_PLAN.md first.
Create /supabase/functions/triage/index.ts. Input: file URL, sender, filename
from an inbound webhook. Apply cheap heuristics first (filename keywords,
known sender patterns). For anything ambiguous, read only page 1 text and
classify via LLM call into: invoice | purchase_order | tax_notice | irrelevant.
Write { doc_type, confidence } to the documents table. Add one test fixture
per doc_type to /tests/triage.
```

**Step 3 — Extraction with fallback**
```
Read /docs/BUILD_PLAN.md first.
Create /supabase/functions/extract/index.ts. For documents where doc_type =
'invoice', call Mindee's Invoice API. For any field with confidence below
0.85, re-extract that specific field using a vision-capable LLM call instead
of trusting the OCR value — do not re-run the whole document, only the
low-confidence field. Store extracted_fields including confidence_scores
and whether ai_fallback_used. Log failures without crashing the pipeline.
```

**Step 4 — Zoho schema mapping**
```
Read /docs/BUILD_PLAN.md first.
Create /supabase/functions/zoho-push/mapping.ts that converts a row from
extracted_fields into the shape Zoho Books' Bill API expects. This file
does field renaming and type conversion ONLY — no matching logic, no
API calls. Keep it pure and unit-testable.
```

**Step 5 — Zoho entity matching**
```
Read /docs/BUILD_PLAN.md first.
Create /supabase/functions/zoho-push/match-entities.ts. Given a mapped
bill and a cached copy of the client's Zoho vendor list and chart of
accounts, resolve vendor_raw to the correct Zoho vendor ID using fuzzy
name matching, and resolve the expense category to the correct GL account.
Where confidence is too low to auto-match, return an unresolved flag
instead of guessing — this should route to human review, never silently
pick the closest match.
```

**Step 6 — Judgment layer**
```
Read /docs/BUILD_PLAN.md first.
Create /supabase/functions/judgment/engine.ts: a rules engine where each
rule is an independent, pluggable function taking an extracted_fields row
and returning { rule_name, passed, notes }. Scaffold the engine and a
rule-registration pattern only — do not invent rule content. Rule logic
itself will be added by hand and documented in /docs/rules-registry.md
as each one is written.
```

**Step 7 — Zoho push connector**
```
Read /docs/BUILD_PLAN.md first.
Create /supabase/functions/zoho-push/index.ts. For a document_id whose
judgment_results all passed and whose entities are resolved, call
mapping.ts and match-entities.ts, then POST to the Zoho Books API via
OAuth2. Log the resulting external_doc_id to erp_sync_log. Handle token
refresh and retry once on failure. Never hardcode credentials.
```

**Step 8 — Review UI**
```
Read /docs/BUILD_PLAN.md first.
Build /apps/web: a React + TypeScript dashboard reading from Supabase
with realtime subscriptions. List documents with status. Clicking a
flagged row shows which judgment rule failed or which entity match was
unresolved, and lets a reviewer approve, correct, or reject before push.
```

**Step 9 — Zoho pull / reconciliation**
```
Read /docs/BUILD_PLAN.md first.
Create /supabase/functions/zoho-pull/index.ts. Store a checkpoint per
connection. Query Zoho for records changed since the checkpoint, fetch
full records, normalize into the extracted_fields shape, and run them
through the same judgment engine from Step 6. Log results identically
to pushed documents, with a link back to the Zoho document ID.
```

---

## 8. Keeping the coding agent aligned across sessions

If you're using Claude Code specifically, save a trimmed version of this file's rules (repo structure, data-handling rules, and current build step) as `CLAUDE.md` at the project root. Claude Code loads that file automatically at the start of every session, so it re-establishes the same constraints — folder structure, security rules, build order — without you re-explaining them each time. Anthropic recommends keeping that file under roughly 200 lines so it doesn't crowd out working context; put the full detail here in BUILD_PLAN.md and only the durable rules in CLAUDE.md. (Reference: https://code.claude.com/docs/en/memory)

---

## 9. Definition of "not broken" between steps

Before moving to the next numbered step:
- [ ] The new function has at least one passing test in `/tests`
- [ ] No secret or key appears in any committed file
- [ ] The new file is in the folder specified in Section 4 — nowhere else
- [ ] Running the previous steps still passes their existing tests
