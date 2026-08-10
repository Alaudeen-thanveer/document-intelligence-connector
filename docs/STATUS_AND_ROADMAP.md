# Status, risks, and roadmap

Companion to [`BUILD_PLAN.md`](./BUILD_PLAN.md). Use this file to brief stakeholders on what the app is today, what to watch out for, and what to build next before a pilot or wider distribution.

---

## What this application is

This is **not an ERP**. It is middleware that sits between inbound documents (email / Drive / OneDrive) and the client's accounting system (currently **Zoho Books**).

The **Document Intelligence Connector** review UI (`/apps/web`) is the human review dashboard only — not books, vendors, or a Zoho replacement.

**Intended end state**

1. Watch inbound docs (email / Drive / OneDrive)
2. Triage document type (invoice, PO, tax notice, etc.)
3. Extract structured fields (OCR + AI fallback)
4. Run a judgment layer (trust checks)
5. If checks pass → push to ERP; if not → human review
6. Keep a full audit trail

---

## What to watch out for right now

| Risk | Why it matters |
|---|---|
| **Not an ERP** | Do not sell or demo it as a Zoho/Books replacement. |
| **No mailbox connector yet** | Nothing auto-pulls from Gmail/Outlook. Demos need manual or sample docs. |
| **Secrets discipline** | Never put Mindee / OpenAI / Zoho keys in source code. Use `.env` / Supabase secrets only. |
| **Open POC RLS** | Review policies and grants are loose for local testing. **Must tighten before any real client data.** |
| **Judgment rules empty** | The engine is a scaffold. Without real rules, “trust” is mostly human review. |
| **Entity match routes to review** | Low-confidence vendor/account matches are not guessed — expect many `needs_review` until caches are good. |
| **Docker / WSL dependency** | Local stack stops if Docker Desktop engine is not running. |
| **Analytics disabled locally** | Fine for POC; do not assume production logging is fully wired. |

---

## Build status (vs BUILD_PLAN)

| # | Component | Status |
|---|---|---|
| 1 | Supabase schema (migrations + RLS) | Done |
| 2 | Triage function + fixtures | Done |
| 3 | Extract (Mindee + LLM fallback) | Done |
| 4 | Zoho bill mapping (`mapping.ts`) | Done |
| 5 | Entity matching (`match-entities.ts`) | Done |
| 6 | Judgment engine scaffold | Done (no real rule content yet) |
| 7 | Zoho push connector | Done (needs live OAuth credentials to exercise) |
| 8 | Review / approval UI (`/apps/web`) | Done |
| 9 | Zoho pull / reconciliation | Not started |
| 10 | Pilot with 3–5 bookkeepers | Not started |
| 11 | Month-end close support | Deferred — post-pilot |
| 12 | Second ERP / SAP | Deferred — client-funded |

**Also in place locally:** Supabase CLI, Docker/WSL setup, applied migrations, review-table grants, `.env` for local keys.

---

## What you can test now vs not yet

| Ready to test now | Not ready yet |
|---|---|
| Local Supabase + core tables | Gmail / Outlook connection |
| Review UI (list / approve / correct / reject) | Real judgment rule content |
| Mapping + entity-match as pure modules | Live Mindee / Zoho without API keys |
| Manual sample docs via Studio **or the Upload invoice control** | Fully hands-off mailbox → ERP pipeline |

### Practical local smoke test

1. Keep Docker Desktop running and start Supabase (`npm run db:start`).
2. Start the dashboard (`npm run web:dev`).
3. In Studio (http://127.0.0.1:54323), insert a sample `documents` row (`status: needs_review`) and optional `judgment_results` / `extracted_fields`.
4. Confirm the row appears in the review UI and try Correct / Approve / Reject.

That validates the **review + database** path. Extraction and Zoho push need API keys and `npm run functions:serve`.

---

## Important features still needed

### Required before a serious demo / pilot

1. **Real judgment rules** — hand-written, registered in the engine, documented in [`rules-registry.md`](./rules-registry.md)
2. **API keys wired** — Mindee, OpenAI, Zoho OAuth in secrets (never in git)
3. **End-to-end sandbox path** — one PDF through extract → review → Zoho push
4. **Tighten RLS + reviewer auth** — stop using open POC policies with real client data
5. **Zoho pull / reconciliation** (BUILD_PLAN Step 9)
6. **Inbound mailbox connector** — Gmail and/or Outlook (poll or webhook into triage)
7. **Passing tests in `/tests`** — per BUILD_PLAN definition of “not broken”
8. **Document retention policy** — explicit policy in `/docs`, then enforce it

### Later (post-pilot)

- Month-end close support
- Second ERP / SAP (client-funded)
- Stronger monitoring, multi-tenant org isolation, retention automation

---

## Recommended plan

### Now (before demoing to anyone serious)

1. Keep migrations applied; confirm the review UI can read `documents`.
2. Seed 3–5 sample invoices in Studio; walk Approve / Correct / Reject.
3. Write 2–3 real judgment rules (e.g. amount present, vendor present, date sane).
4. Add keys to `.env` and test **extract → review** on one PDF.
5. Use a Zoho sandbox to test **push** on one approved bill.

### Next (pilot-ready)

6. Complete Step 9 — Zoho pull / reconcile.
7. Connect one Gmail or Outlook mailbox for inbound docs.
8. Lock RLS and add simple reviewer login.
9. Ensure every approve/reject is logged with `reviewed_by`.
10. Run a pilot with 3–5 bookkeepers (BUILD_PLAN step 10).

### Later (post-pilot / distribution)

11. Month-end close support.
12. Second ERP / SAP when a client funds it.
13. Retention automation, production monitoring, multi-tenant hardening.

---

## How to think about “distribution”

| Stage | What “shipping” means |
|---|---|
| **Internal POC** | Local Docker + review UI + sample docs |
| **Client pilot** | Hosted Supabase + secrets + one mailbox + Zoho sandbox + real judgment rules |
| **Product distribution** | Only after pilot feedback — not after Step 8 alone |

**One-line summary:** The repo has a solid **reviewable pipeline skeleton**. Watch security/RLS and overclaiming automation. Add **real rules, mailbox ingest, Zoho sandbox E2E, then pull/auth** before calling it pilot-ready.

---

## Related docs

- [`BUILD_PLAN.md`](./BUILD_PLAN.md) — product definition and strict build order
- [`rules-registry.md`](./rules-registry.md) — judgment rules (fill as each rule is written)
