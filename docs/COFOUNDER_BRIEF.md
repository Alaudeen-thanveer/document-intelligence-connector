# Co-founder brief — Document Intelligence Connector  
**Current state (as of now)**

---

## In one sentence

We are building middleware that turns inbound business documents (especially invoices) into verified data and pushes them into Zoho — **not** a new accounting/ERP product.

---

## What it is supposed to do (end vision)

1. Documents arrive (email / Drive / upload)
2. System classifies them (invoice, PO, tax notice, etc.)
3. Key fields are extracted (vendor, amount, date)
4. Judgment rules check whether the data is trustworthy
5. If checks pass → push into Zoho Books  
   If not → a human reviews, corrects, approves, or rejects
6. Everything is logged for audit

**Success for the POC:** an invoice becomes a correct Zoho bill with a clear trail of what was extracted, what passed/failed, and who approved it — without someone re-keying the bill by hand.

---

## What works today

We have the **foundation and review loop**, runnable locally:

| Built | What that means in practice |
|---|---|
| Database + security baseline | We can store documents, extractions fields, judgment results, and ERP sync history |
| Processing functions (code) | Triage, extraction, Zoho field mapping, vendor/account matching, Zoho push, judgment engine scaffold |
| Review dashboard | Web UI to list documents, upload an invoice manually, and Approve / Correct / Reject |
| Local environment | Supabase + Docker running on a developer machine |

**How it works right now (honestly):**

- A user can **manually upload** an invoice in the web UI (file goes to storage; a document record is created).
- That document shows up in the **review dashboard**.
- A reviewer can **correct fields, approve, or reject**.
- The deeper automation (OCR extract → auto judgment → Zoho push) exists as **code**, but is not a finished hands-off production flow yet. It needs API keys, real judgment rules, and mailbox/ERP wiring to run end-to-end.

So today we can demo: **“document in → human review queue → decision.”**  
We cannot yet demo: **“Gmail invoice arrives → fully automatic Zoho bill with no human touch.”**

---

## What we still need to develop

### Must-have before a real client pilot

1. **Email/mailbox ingest** — connect Gmail or Outlook so invoices are not only manual uploads  
2. **Real judgment rules** — the rules engine is empty scaffolding; trust checks must be written and documented  
3. **Live API credentials** — Mindee (OCR), OpenAI (fallback), Zoho OAuth — securely configured  
4. **End-to-end sandbox run** — one real invoice through extract → review → Zoho push  
5. **Zoho pull / reconciliation** — catch bills entered manually in Zoho and run them through the same checks  
6. **Tighter security** — current review access is open for local POC; must lock down before real client data  
7. **Basic tests** — prove each step still works as we add the next

### Later (after pilot)

- Month-end close support  
- Second ERP (e.g. SAP) — only when a client funds it  
- Stronger multi-tenant / production hardening  

---

## What this is *not*

- Not a Zoho Books competitor  
- Not a full bookkeeping app  
- Not “just OCR” — extraction is necessary, but the product value is **judgment + ERP handoff + audit trail**

---

## Suggested next 2 weeks (practical)

1. Write 2–3 judgment rules and show them failing/passing in the UI  
2. Connect sandbox keys and run one invoice through extract → review  
3. Push one approved bill into Zoho sandbox  
4. Decide mailbox path (Gmail vs Outlook) for the pilot  

---

## Bottom line for decision-making

**We are past “idea” and into a working technical skeleton with a usable review UI.**  
**We are not yet at “automated Gmail-to-Zoho product.”**  

Investment now should focus on: **real rules, live connectors (mailbox + Zoho), and one clean end-to-end pilot path** — not more UI polish or a second ERP.
