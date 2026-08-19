/**
 * Multi-currency revaluation — pure parts.
 *
 * Zoho Books does the actual revaluation ("base currency adjustment"):
 * given a currency, a date and a rate, it lists the affected accounts
 * (GET /basecurrencyadjustment/accounts) and posts the gain/loss
 * (POST /basecurrencyadjustment). What this module owns:
 *   • which currencies deserve a month-end nudge (any non-base currency
 *     with exposure — foreign-currency accounts or open documents);
 *   • validating the reviewer-supplied period-end rate;
 *   • the exact request body, so the edge function stays thin.
 *
 * The RATE is the reviewer's: month-end closing rates are a policy choice
 * (central bank fix, bank rate, treasury policy). We default the field to
 * Zoho's stored rate when one exists and never invent one.
 */

export interface FxExposure {
  currency_id: string;
  currency_code: string;
  stored_rate: number | null;  // Zoho's current exchange rate for the currency (0/absent = none)
  account_count: number;       // accounts Zoho reports as affected at the probe rate
  accounts: Array<{ account_id: string; account_name: string; gl_balance?: number | null; fcy_balance?: number | null; adjusted_balance?: number | null; gain_or_loss?: number | null }>;
}

export function validateRate(rate: unknown): { ok: true; rate: number } | { ok: false; error: string } {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return { ok: false, error: "The period-end exchange rate must be a positive number (units of base currency per 1 unit of the foreign currency)." };
  if (r > 10000) return { ok: false, error: "That rate looks off by orders of magnitude — check the direction (base per 1 foreign unit)." };
  return { ok: true, rate: r };
}

/** Params for GET /basecurrencyadjustment/accounts and POST /basecurrencyadjustment. */
export function bcaParams(currencyId: string, date: string, rate: number, notes: string): Record<string, string> {
  return {
    currency_id: currencyId,
    adjustment_date: date,
    exchange_rate: String(rate),
    notes: notes.slice(0, 200),
  };
}

/** Query-string side of the create (verified live: account_ids must be a CSV in the query, the entity in the body). */
export function bcaBody(accountIds: string[]): Record<string, string> {
  return { account_ids: accountIds.join(",") };
}

/** Parse Zoho's accounts listing into an exposure row. */
export function parseBcaAccounts(currencyId: string, currencyCode: string, storedRate: number | null, raw: Record<string, unknown>): FxExposure {
  const data = (raw.data ?? raw) as Record<string, unknown>;
  const list = ((data.accounts ?? []) as Array<Record<string, unknown>>).map((a) => ({
    account_id: String(a.account_id ?? ""),
    account_name: String(a.account_name ?? ""),
    gl_balance: a.gl_balance != null ? Number(a.gl_balance) : null,
    fcy_balance: a.fcy_balance != null ? Number(a.fcy_balance) : null,
    adjusted_balance: a.adjusted_balance != null ? Number(a.adjusted_balance) : null,
    gain_or_loss: a.gain_or_loss != null ? Number(a.gain_or_loss) : null,
  })).filter((a) => a.account_id);
  return { currency_id: currencyId, currency_code: currencyCode, stored_rate: storedRate && storedRate > 0 ? storedRate : null, account_count: list.length, accounts: list };
}
