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

## How to add a rule

1. Write an independent function `(row) => ({ rule_name, passed, notes })`.
2. Call `registerRule("your_rule_name", yourFn)`.
3. Document it in the table above (name, intent, pass criteria).
