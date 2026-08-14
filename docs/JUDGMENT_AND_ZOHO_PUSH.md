# Judgment rules & Approve → Zoho

Document Intelligence Connector — quick reference for Phase steps **1.2** (judgment) and **1.3** (Zoho push on human approve).

---

## 1. Automatic judgment rules (only these three)

These run when you call the `judgment` function (also after upload / **Run extract + judgment** in the UI). Results are stored as rows in `judgment_results`.

| Rule name | What it checks | Passes when | Fails when |
|---|---|---|---|
| `duplicate_vendor_amount_date` | Same vendor + amount + invoice date | No matching peer document in the same company within the day window | Same vendor + amount + date found within the window |
| `missing_supporting_document` | Supporting document present | `documents.has_supporting_document = true` | Flag is false / missing |
| `amount_above_threshold_no_po` | High amount without a PO | Amount ≤ company threshold **or** `po_number` is set | Amount **above** threshold and no PO |

### Config (per company — `company_config`)

- `duplicate_check_days` — default **3**
- `amount_requires_po_threshold` — default **5000** (may be changed for tests, e.g. 1000)

### Not a fourth automatic rule

On **Approve**, the UI may insert `human_review_approval` or mark failed rules as passed with “Approved by {reviewer}”. That is a **human override / audit** row, not part of the automatic 3-check set.

The pluggable rules engine scaffold (`judgment/engine.ts`) has **no registered rules** yet — only the three hardcoded checks run.

---

## 2. What Approve → Zoho does

### Preconditions

- Document must have an `extracted_fields` row (vendor, amount, date).
- Button is disabled if fields are missing or status is already `synced`.
- Edge functions must be running:  
  `npx supabase functions serve --env-file .env`

### Step-by-step

1. **Human override** — any failed judgment rows are set to `passed: true` (noted as approved by reviewer). If none failed, insert `human_review_approval`.
2. **Status** → `approved`.
3. **`zoho-push` runs:**
   - Confirms human approval + all judgment rows pass
   - Resolves or **auto-creates** vendor in the Zoho org from `.env`
   - Uses expense account from `ZOHO_DEFAULT_ACCOUNT_ID` / `ZOHO_EXPENSE_CATEGORY`
   - Creates a **Bill** (with explicit `bill_number`)
   - **Attaches** the invoice file from Storage
   - Writes `erp_sync_log` with Zoho `bill_id`
4. **Status** → `synced` on success.

### Outcomes

| Result | Document status | Meaning |
|---|---|---|
| Success | `synced` | Bill created in Zoho; attachment uploaded; `erp_sync_log` has `external_doc_id` |
| Push failed | `approved` | App approved, but Zoho did not complete — check the green/red message in the UI |
| Blocked | unchanged | No extract yet — Approve refused |

Approve is **not** a dry run: success creates a real bill in your Zoho test organization.

---

## 3. How to know something was pushed

1. **UI** — status `synced`, “Zoho bill” id shown, success message with bill id + attachment note  
2. **Studio** — table `erp_sync_log` → `external_doc_id` = Zoho bill id  
3. **Zoho Books** — switch to org `ZOHO_ORGANIZATION_ID` → Bills → open that bill → confirm PDF attachment  

---

## 4. Suggested test flow in the UI

1. Start Supabase + functions serve + web UI (`npm run web:dev`).
2. Upload a clear invoice (or **Run extract + judgment** on an existing upload).
3. Confirm the right panel shows **this document’s** vendor / amount / date (not empty).
4. Review the three judgment rows (pass/fail).
5. Click **Approve → Zoho**.
6. Verify `synced` + Zoho bill + attachment.

### Example expectations

- **Clear invoice with PO** (e.g. Bright Peak + PO number) — amount/PO check usually **passes**; good Approve candidate.  
- **High amount, no PO** — amount/PO check usually **fails** until you Correct a PO or Approve overrides failed rules.

---

## 5. Related files

| Area | Path |
|---|---|
| Checks | `supabase/functions/judgment/checks.ts` |
| Judgment runner | `supabase/functions/judgment/index.ts` |
| Zoho push | `supabase/functions/zoho-push/index.ts` |
| Review UI Approve | `apps/web/src/components/ReviewPanel.tsx` |
| Rules registry | `docs/rules-registry.md` |
