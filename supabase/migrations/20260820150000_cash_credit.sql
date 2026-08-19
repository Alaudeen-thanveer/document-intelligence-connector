-- Roadmap items 13-15: collections, payment run, credit control.
--
-- • payment_run_horizon_days: how far ahead "which bills to pay this week"
--   looks (due dates within the horizon, plus everything overdue).
-- • credit_limits: app-side customer credit limits, keyed by the customer's
--   Zoho id ({"1365...": 5000}). Zoho Books has its own credit_limit field
--   but the toggle that enables it is UI-only (verified on the .ae DC:
--   code 75100, not settable via the preferences API) — when the org turns
--   it on, Zoho's field wins and this map is the fallback.

alter table public.company_config
  add column if not exists payment_run_horizon_days integer not null default 7,
  add column if not exists credit_limits jsonb not null default '{}'::jsonb;
