# Document Intelligence Connector  
## Product Summary & Current Build Status

---

## 1. Product summary

**Document Intelligence Connector** is middleware between inbound business documents and the client’s accounting system (**Zoho Books** today).

It is **not**:

- a bookkeeping app  
- a Zoho competitor  
- “just OCR”

**Point of the product:** cheap extraction + **judgment** (is this trustworthy?) + controlled ERP push + human review when unsure + full audit trail.

**POC “done” looks like:** an invoice becomes a correct Zoho bill, with a clear record of what was extracted, what passed/failed, and who approved it — without manual re-keying.

---

## 2. How it’s supposed to work (end vision)

1. Documents arrive (Email / Drive / Upload)  
2. **Triage** — classify as invoice | PO | tax notice | irrelevant  
3. **Extract** — OCR, with AI only for low-confidence fields  
4. **Judgment rules** — trust checks  
5. If checks **pass** → Zoho push  
   If checks **fail** → Human review (approve / correct / reject)  
6. Later: **Zoho pull** (catch manually entered bills)  
7. Everything is written to an **audit log**

---

## 3. How far it’s built (honest status)

| Layer | Status | Nuance |
|---|---|---|
| Data model | Done | documents, extracted_fields, judgment_results, erp_sync_log + RLS baseline |
| Triage | Code done | Heuristics + LLM fallback; needs live keys / inbound feed |
| Extract | Code done | Mindee + per-field vision LLM; needs API keys |
| Zoho mapping | Done | Pure rename / type convert only |
| Entity matching | Done | Fuzzy vendor/GL match; will not guess below confidence threshold → review |
| Judgment | Scaffold only | Engine exists; no real rules yet |
| Zoho push | Code done | OAuth + retry; blocked until judgments pass + Zoho credentials |
| Review UI | Done | Upload invoice, list docs, approve / correct / reject |
| Mailbox ingest | Not built | No Gmail / Outlook yet |
| Zoho pull | Not built | Still open |
| Team Git | Done | GitHub main + staging; feature branches → staging → main |

### What works today in practice

Manual upload → document appears in queue → human review decisions.  
That proves the **review loop**.

### What does not work hands-off yet

Gmail → auto extract → auto Zoho with no human.  
That is the next build arc.

---

## 4. Important nuances (easy to misunderstand)

1. **Middleware, not ERP** — Zoho remains the system of record.  
2. **Extraction is not the product** — judgment + safe push + audit are.  
3. **Uncertainty routes to humans** — unresolved entity matches and failed rules go to review; silent “closest match” is intentionally avoided.  
4. **Local POC security is loose** — open policies for demos; must tighten before real client data.  
5. **`judgment_not_passed` is normal** — empty rules / no approval means Zoho push correctly refuses.  
6. **Secrets never in git** — `.env` stays local; each developer fills their own keys.  
7. **Docker / Supabase required locally** — UI and database depend on Docker engine + `supabase start`.  
8. **Staging is the team integration branch** — features merge to staging for testing, then to main.

---

## 5. One-line status

**We have a working foundation and review UI; the automated mailbox → judgment → Zoho product is designed and partly coded, but not finished end-to-end yet.**

---

## 6. Sensible next build order

1. Live extract on uploaded invoices  
2. First real judgment rules  
3. Zoho sandbox push on approve  
4. One mailbox auto-ingest  
5. Auto-route: pass → push / fail → review  
6. Zoho pull + tighter auth for pilot  

---

*Document Intelligence Connector — internal summary*  
*Generated for co-founder / stakeholder alignment*
