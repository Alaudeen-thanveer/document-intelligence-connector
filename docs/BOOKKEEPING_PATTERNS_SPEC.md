# Bookkeeping Patterns — Onboarding Knowledge Base

**Status:** All six layers built as propose-only — party→account, recurrence, attachments, reporting tags + projects (bills/invoices/expenses/journals), manual journal patterns (undeclared recurring journals, by account fingerprint), timing / payment behaviour (entry lag, actual DPO/DSO vs terms, mode/account) — with enabled checks wired into the judgment engine and month-end nudges (recurring journals declared *and* learned, expected-but-missing bills, open-longer-than-usual). Companion to [`BUILD_PLAN.md`](./BUILD_PLAN.md) and [`rules-registry.md`](./rules-registry.md).

## 1. What this is

When a customer connects their Zoho Books, their historical bills, invoices, journals and attachments already encode how their accountant keeps the books: which account each vendor posts to, which bills recur, whether a delivery note is normally attached, how invoice numbers are formatted. Those conventions are the real rules of that business, and today someone has to *know* and *type* them (the vendor/customer account rules).

This spec describes an **onboarding job that reads a range of history once, distils the conventions into a per-customer knowledge base, and keeps learning from every approved document.** The knowledge base then pre-fills and sanity-checks new documents — always as suggestions the reviewer confirms, never as silent auto-fills.

**What this is not:** it is not a replacement for the judgment engine or the rules screens. It *feeds* them — proposing rules with evidence, and tightening existing checks per vendor.

## 2. Two principles that are not optional

**Propose, don't impose.** Every learned pattern surfaces as a suggestion with its evidence — “History suggests Cargo Expense (94% of 31 bills)”. The accountant stays the authority. A pattern with a small sample says so. Nothing learned ever writes to Zoho or auto-approves a document.

**History encodes habits, not correctness.** If a customer has posted something to the wrong account for two years, the pattern will look confident and be wrong. Onboarding therefore ends with a human pass over the top vendor and customer profiles before they go live.

## 3. Patterns to extract

Grouped by what each one buys the pipeline. Priority reflects build order (§7).

### 3.1 Party → account profile — priority 1

For each vendor and customer, tally which GL account their historical lines posted to.

| Learn | From | Feeds |
|---|---|---|
| Dominant expense/income account + share | bill / invoice line items | proposes `vendor_account_rules` / `customer_account_rules` with a confidence |
| Split pattern (no single dominant account) | same | flags the party as “line-level attention” — correlates with multi-line invoices where lines go to different accounts (the “as per line items” case) |
| Typical tax treatment, currency, payment terms | bill / invoice headers | pre-fills the review screen |
| PO usually present? | `reference_number` / PO links | tightens `amount_above_threshold_no_po` per vendor |
| Typical amount range (median, p10–p90) | totals | anomaly check (§3.2) |

### 3.2 Recurrence — priority 2

Group each vendor's bills by date and amount into a cadence class.

| Class | Signature | Example |
|---|---|---|
| Fixed recurring | monthly, amount within ±2% | rent, subscriptions, retainers |
| Variable recurring | monthly, amount varies | utilities, telecom |
| Irregular | no cadence | project purchases |

Feeds three checks that the current `duplicate_vendor_amount_date` cannot express:

- **Smarter duplicate:** a fixed-recurring bill appearing twice in one period is suspicious *even at a different amount*.
- **Anomaly:** a variable-recurring bill far outside its historical range (e.g. > p90 × 3) is flagged.
- **Expected-but-missing:** at period end, a recurring bill that has not arrived is surfaced (a nudge, not a failure).

### 3.3 Recurring journal entries — priority 5

Zoho exposes recurring journals directly; manual journals with the same account set and period are matched as a pattern. Not something the document pipeline creates — this is *context* for the knowledge base: the accountant's month-end routine (depreciation, accruals, prepayment amortisation, provisions). Becomes the checklist when month-end support is built (BUILD_PLAN step 11).

### 3.4 Items per customer, item → account — priority 4

For invoices: which items each customer buys, which income account each item posts to, and the usual rate per customer. Feeds the invoice side of review (customer + item pre-fill) and a pricing-consistency check.

### 3.5 Attachment conventions — priority 3

Per vendor: how many documents are attached to a bill and of what type (invoice only, invoice + delivery note, invoice + PO; or none when entered from a statement).

Feeds `missing_supporting_document` per vendor: strict for a goods vendor whose bills always carry a delivery note; relaxed for a utility that never has one. Also defines what “complete” looks like for this customer.

### 3.6 Numbering and reference conventions — priority 3

How bill numbers, reference numbers and invoice numbers are formatted per vendor, and *where* the accountant puts the vendor's number (bill_number vs reference_number). Feeds validation of extracted invoice numbers and correct duplicate detection.

### 3.7 Timing conventions — priority 6

Gap between invoice date and entry date; between entry and payment. Feeds the customer's *actual* payment behaviour per vendor (vs nominal terms) and the month-end “what's still unbooked” view.

### 3.8 Chart-of-accounts usage — priority 2 (cheap)

Which accounts are *used* vs merely defined. Feeds the review screen: show the ~15 accounts this customer actually uses first, the rest under “more”.

## 4. Knowledge base shape

Three layers, every entry carrying `sample_size`, `confidence`, and `last_seen`.

| Layer | Example entry |
|---|---|
| **Party profiles** | Falcon Logistics FZE → Cargo Expense (0.94, n=31), AED, vat_registered, irregular cadence, 1 attachment |
| **Rhythms** | DEWA → variable-recurring, 1st–5th monthly, median 4,200 AED, p10–p90 3,600–5,100 |
| **Conventions** | bill_number = vendor's invoice no · PO required above 5,000 · delivery notes attached for goods vendors |

Proposed tables (per `company_id`):

```
bk_party_profiles   (company_id, party_kind, party_zoho_id, dominant_account_id, account_share,
                     account_split jsonb, tax_treatment, currency, payment_terms_id,
                     po_usually_present, amount_median, amount_p10, amount_p90,
                     cadence, attachment_count_mode, attachment_types jsonb,
                     sample_size, confidence, last_seen, computed_at)
bk_rhythms          (company_id, party_zoho_id, cadence, expected_day_range,
                     amount_median, amount_p10, amount_p90, last_seen, next_expected)
bk_conventions      (company_id, key, value jsonb, evidence jsonb, confidence)
bk_suggestion_log   (company_id, document_id, field, suggested, accepted, overridden_to, at)
```

`bk_suggestion_log` is the learning loop: every reviewer override is the most valuable signal (the convention changed, or the suggestion was wrong).

## 5. Data sources (Zoho Books API)

All available on the connection already in place. Line-item detail requires fetching **each bill/invoice individually** — the list endpoints do not include lines.

| Pattern | Endpoints |
|---|---|
| Party → account, amounts, timing | `bills`, `bills/{id}`, `invoices`, `invoices/{id}` |
| Recurrence | same, grouped by vendor + date |
| Journals | `journals`, `recurringjournals` (where the DC exposes it) |
| Items per customer | `invoices/{id}` line items, `items` |
| Attachments | `bills/{id}` → `documents[]` |
| Payments / timing | `vendorpayments`, `customerpayments` |

**Cost caution.** 24 months of a mid-sized org is thousands of per-document calls. Run as a **one-time onboarding job with backoff**, resumable by cursor, using the cached access token (`zoho_oauth_tokens`) — never on demand. Store the raw pulls so re-analysis does not re-fetch.

## 6. Where suggestions surface

- **Rules screen:** “Suggested rules from history” list — one click promotes a proposal to a real `vendor_account_rules` row; the evidence stays visible.
- **Review screen:** account / treatment / currency pre-filled from the party profile, labelled with the evidence; overrides logged.
- **Judgment engine:** the recurrence and attachment patterns become per-vendor parameters for existing checks (a new rule per pattern, registered per `rules-registry.md`).
- **Connections page:** a “Knowledge base” tile per connection — profiles learned, coverage, last learned.

## 7. Build order

1. Party → account profiles (replaces hand-typed rules; easiest to validate)
2. Chart-of-accounts usage + recurrence (unlocks smarter duplicate / anomaly checks in the engine that already exists)
3. Attachment + numbering conventions (tightens existing supporting-document and duplicate checks per vendor)
4. Items per customer (invoice side)
5. Recurring journals (month-end context)
6. Timing (payment behaviour)

Each step ships as: onboarding job → tables → suggestions surface → override logging. Continuous learning (every approved document updates the profile) is part of step 1, not a later phase.

## 8. Open questions

- History range: default 12 or 24 months? Configurable per customer at onboarding.
- Minimum `sample_size` before a suggestion shows at all (proposed: 3).
- Whether onboarding runs in Supabase edge functions (60s limit — would need chunking) or a separate worker.
- Multi-tenant isolation: every table is keyed by `company_id`; RLS must be real before a second customer.
