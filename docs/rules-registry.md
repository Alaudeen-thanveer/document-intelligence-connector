# Judgment rules registry

Plain-language list of every judgment rule. Keep this file in sync with
code registered via `registerRule` in `/supabase/functions/judgment`.

Rule logic is added by hand — the engine in `engine.ts` is only the
registration + run scaffold.

## Rules

| rule_name | What it checks | Pass criteria | Notes / owner |
|---|---|---|---|
| *(none yet)* | — | — | Add a row here when you register a rule |

## How to add a rule

1. Write an independent function `(row) => ({ rule_name, passed, notes })`.
2. Call `registerRule("your_rule_name", yourFn)`.
3. Document it in the table above (name, intent, pass criteria).
