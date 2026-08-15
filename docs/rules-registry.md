# Judgment rules registry

Plain-language list of every judgment rule. Keep this file in sync with
code registered via `registerRule` in `/supabase/functions/judgment`.

Rule logic is added by hand — the engine in `engine.ts` is only the
registration + run scaffold.

## Rules

| rule_name | What it checks | Pass criteria | Notes / owner |
|---|---|---|---|
| `duplicate_vendor_amount_date` | Same vendor + amount + invoice date within `company_config.duplicate_check_days` (default 3) | No peer match in window | Hardcoded in `checks.ts` (not engine registry) |
| `missing_supporting_document` | Invoice has a supporting document | `documents.has_supporting_document = true` | Hardcoded in `checks.ts` |
| `amount_above_threshold_no_po` | Amount above per-company PO threshold without a PO | amount ≤ threshold **or** `po_number` present | Threshold: `company_config.amount_requires_po_threshold` |

### Learned per-vendor checks (opt-in)

Proposed by `bookkeeping-learn` from Zoho history, stored in `bk_check_proposals`, and **run only when a human sets the row to `enabled`** on the Rules screen. Proposed / dismissed rows have no effect. The vendor is matched from `vendor_raw` to a synced Zoho vendor by exact normalized name — no fuzzy match, so another vendor's checks can never apply. Logic in `judgment/learned_checks.ts`.

| rule_name | What it checks | Pass criteria | Notes |
|---|---|---|---|
| `learned_recurring_twice_in_period` | For a monthly-recurring vendor, another document from the same vendor in the same calendar month | No other doc from this vendor in the invoice's month | Catches duplicates at a *different* amount, which the base duplicate check cannot |
| `learned_amount_anomaly` | Amount vs the vendor's learned range | fixed: within `tolerance_pct` of `median` · variable: within `p10–p90` widened `×multiplier` | Params come from the accepted proposal |
| *(overrides `missing_supporting_document`)* | Per-vendor strictness for supporting docs | strict: doc required · relaxed: never fails · standard: base check | Kind `supporting_document_strictness`; replaces the base verdict rather than adding a row |

## How to add a rule

1. Write an independent function `(row) => ({ rule_name, passed, notes })`.
2. Call `registerRule("your_rule_name", yourFn)`.
3. Document it in the table above (name, intent, pass criteria).
