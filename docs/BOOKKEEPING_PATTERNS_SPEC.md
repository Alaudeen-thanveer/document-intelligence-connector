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

### 3.9 Bank statement lines — built (bank layers 1–4)

**What it learns.** For every categorised bank transaction in Zoho Books, every customer/vendor payment (its description + reference), and every statement line a reviewer confirms in this app: the statement description's *fingerprint* (salient words after stripping numbers, references and bank boilerplate — `bank_patterns.ts`), the side (money in / money out), and what the bookkeeper decided it was — party, account, and kind (customer receipt, vendor payment, expense, deposit, transfer). Grouped by (fingerprint, side); the dominant decision becomes the pattern with `share`, `sample_size`, amount band and confidence `share × (1 − 1/(n+1))`. Same words on opposite sides are different habits (a POS payment vs a refund).

**What it suggests, per line, or nothing.** When a statement comes in (CSV/TSV upload, PDF via the vision model, pasted text, or — once the mailbox is wired — an email body/attachment through the same `ingest` entry point), every line gets at most one suggestion, in order of trust:
1. **Open document** — money in that names an unpaid invoice's number or equals its balance (party name breaks amount ties) → *customer receipt applied to that invoice*; money out likewise → *vendor payment applied to that bill*. An amount-only match with two candidates at that amount is ambiguous → no suggestion.
2. **Learned pattern** — the fingerprint matches (all tokens, or ≥⅔ of a 3+-token pattern) and score ≥ 0.55 → the usual party / account / kind, labelled *learned* (or *your rule* once accepted).
3. **Party name** in the line with nothing else → the party only, kind by side, no account, low confidence.
Below the gate, or nothing at all → the line stays **open**; the reviewer fills it. A split habit (e.g. salary batch booked two ways) scores under the gate and is deliberately not suggested.

**Propose, don't impose, structurally.** Suggestions live in `bank_statement_lines.suggestion`; the reviewer's decision lives in `chosen_*` and is the only thing that ever reaches Zoho (`push.ts`: `/customerpayments` with `invoices[]`, `/vendorpayments` with `bills[]`, `/expenses` paid through the bank, `/banktransactions` for deposits and transfers). Confirm records whether the reviewer *accepted*, *changed* or *filled a blank* — the disagreement signal. Vendors/customers must exist in Zoho Books (synced cache, or the party Zoho itself returned on the matched open document). Every confirmed/posted line becomes an observation for the next learn, so the app learns from decisions without creating any rule.

**Phase 1 — getting the payment record right (built).** Before anything else a line is checked against what THIS APP already posted (posted statement lines and documents pushed as expenses) for the same party/description and amount within `company_config.already_recorded_window_days` — if found, the suggestion is *link, don't create* and push creates nothing. Then, per line: refunds (money out to a customer = open credit note / unused payment → credit-note or payment refund; money in from a vendor = open vendor credit / unused payment → vendor-credit or vendor-payment refund), retainer receipts, and open-document allocation across several invoices/bills (named in the line → exact subset-sum → oldest-due-first). Short by ≤ `bank_charge_tolerance[currency]` (default AED 5, USD 13; other currencies none) → settle in full + bank charges (customer payments natively; vendor side as a bank-charge expense — and only when the line is OVER, since a short vendor payment is a partial); short by more → partial, residual stays open; over → the remainder is an advance (unused credit), never forced onto a document. Write-off of a residual is proposed only when the company has set its IFRS-based policy (`writeoff_after_days` + `writeoff_max_amount`, both NULL by default) and the document is old enough. On the review screen, unused credit the chosen party holds is offered as "apply to this invoice/bill?" and applied on push via `/invoices/{id}/credits` or `/bills/{id}/credits` only when ticked. Confirm records accepted / changed / filled-blank; guards refuse allocations that exceed the line and write-offs without a policy. Test: `bank-phase1-payment-record-accuracy`.

**Feed mode (built).** When the lines already live in Zoho Books as *uncategorised transactions* (a bank feed, or a statement imported in Zoho), `pull_feed` pulls them per bank account into a statement with source `zoho_feed`, runs the same engine, and additionally asks Zoho for its own **match candidates** per line (`GET …/uncategorized/{id}/match`) — a record already in the books that the line should be *linked* to; those outrank creating anything. On push the decisions are applied in Zoho with its own verbs: `…/match`, `…/categorize/{customerpayments|vendorpayments|expenses|creditnoterefunds|vendorcreditrefunds|paymentrefunds|vendorpaymentrefunds}`, the generic `…/categorize` (deposit / transfer / other), or `…/exclude`. Zoho keeps the statement and the reconciliation; there is one copy of every line. "Exclude" is a learnable decision. One known limit: a vendor payment with a bank charge cannot become two records from one uncategorised line — the push says so. `feed.ts`; test `bank-feed-mode-accuracy`.

**Tables:** `bk_bank_patterns` (layer 1), `bank_statements` + `bank_statement_lines` (layers 2–4, phase-1 and feed columns), policy columns on `company_config`. **Function:** `bank-statement` (`ingest` / `suggest` / `confirm` / `push` / `party_credits`). **UI:** the Bank page (policies card, allocation editor); Review panel (unused-credit prompt). **Tests:** `bk-bank-layer1-accuracy`, `bank-layer2-parse-accuracy`, `bank-layer3-suggest-accuracy`, `bank-phase1-payment-record-accuracy`.

### 3.10 Zoho bank rules — built (both directions)

**Rules as evidence.** The org's own bank rules (`GET /bankaccounts/rules`, detail-enriched — the list view omits `vendor_id`/`auto_categorize` on the .ae DC) sync as `zoho_entities` kind `bank_rule`. At suggestion time a rule that applies to a line (side, account scope, and/or criteria over description / payee / reference / amount) proposes what it records, labelled *your Zoho bank rule* at 0.9 (recognize) / 0.95 (autocategorize). Order of trust: already-recorded and open documents still outrank a rule (a payment application beats a categorisation); a rule outranks learned patterns and name-only guesses. `zoho_rules.ts`; test `bank-zoho-rules-accuracy`.

**Learned patterns as rules.** A pattern with confidence ≥ 0.9 over ≥ 12 lines that records an expense/deposit/transfer (never a payment — a rule cannot know the allocation) can be proposed AS a Zoho rule from the Bank page — always `auto_categorize: "recognize"` (suggest-only), criteria = description contains each fingerprint word. UAE orgs refuse an expense rule without VAT treatment (code 111865) — retried once with `tax_treatment: "vat_registered"` + the org's standard-rate tax. `bk_bank_patterns.zoho_rule_id` remembers the proposal; never proposed twice. Actions `rule_proposals` / `propose_zoho_rule`. Verified live: rule created, cached, and suggesting.

### 3.11 Month-end: reconciliation and journal proposals — built

**Bank reconciliation (item 4).** Per bank account at period end: the newest statement line balance on/before period end vs Zoho's `running_balance` of the last categorised transaction (remember Zoho's ledger view: debit = money in). The difference is itemised — statement lines still open/confirmed here, Zoho's uncategorised feed lines (a movement present as both counted once), and whatever remains is named *unexplained*. When balanced, nothing pending, and the period has passed, one click posts `POST /bankaccounts/{id}/reconciliations` `{start_date, end_date, closing_balance, save_option: "reconcile", transactions_to_be_reconciled: [ids]}` (shape verified live; Zoho refuses a future end_date with 1043, one in-progress reconciliation blocks the next with 19009, `DELETE …/reconciliations/{id}` undoes). Recomputed server-side before posting — the client's numbers are never trusted. `month-end/reconciliation.ts`.

**Journal proposals (item 5).** For every ENABLED learned journal pattern not posted in the period, month-end stores a draft in `bk_journal_proposals` (unique per pattern × period): the usual day clamped into the period, the pattern's accounts with sides, median spread over each side (zero amounts when no median — the reviewer fills them). The reviewer edits amounts/date, then `post_journal` validates (balanced, > 0, real date) and posts `POST /journals`; `dismiss_journal` says "not this month". Posted proposals remember the Zoho journal id and can never post twice. `month-end/journal_proposals.ts`; test `month-end-recon-journals-accuracy`; both verified live.

### 3.12 Purchase orders → bills, three-way match — built

`zoho-pull` syncs open POs with their lines (kind `purchase_order`; ordered qty, `quantity_billed`, rate). Extraction reads the PO number off the bill (`po_number`, Mindee + Gemini fallback). The judgment check `po_match` then compares ordered vs billed vs already-billed: PO found by number **or reference** (orgs with auto-numbering keep the human tag in `reference_number`), else same vendor + total within tolerance when unique; totals within `max(po_variance_pct %, po_variance_amount)` (company settings, default 2% / 10); per-line rate within the percentage, quantity within what remains unbilled; a bill line not on the PO is named. No PO referenced and none found → not applicable (the amount-above-threshold check owns the missing-PO policy). On approve, the bill carries `purchaseorder_ids` — Zoho links it, consumes quantities and closes the PO. `judgment/po_match.ts`; test `po-match-accuracy`; verified live both ways (matching bill passes and links; over-billed bill fails with "billed 14 but only 10 of 10 remain unbilled").

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
7. Bank statement lines: learn from categorised bank history → ingest statements → suggest per line (open document / learned / party name / nothing) → confirm → post; confirmations feed the learner. **Built.**

Each step ships as: onboarding job → tables → suggestions surface → override logging. Continuous learning (every approved document updates the profile) is part of step 1, not a later phase.

## 8. Open questions

- History range: default 12 or 24 months? Configurable per customer at onboarding.
- Minimum `sample_size` before a suggestion shows at all (proposed: 3).
- Whether onboarding runs in Supabase edge functions (60s limit — would need chunking) or a separate worker.
- Multi-tenant isolation: every table is keyed by `company_id`; RLS must be real before a second customer.
