/**
 * Corporate tax provision — pure. Schedule-driven (rides on the journal
 * proposal machinery, kind "ct_provision").
 *
 * UAE corporate tax: 9% (company setting) on taxable income above
 * AED 375,000 (company setting). Each period the provision to date is
 *   max(0, (net profit FY-to-date − threshold)) × rate
 * and the proposal is the TOP-UP: provision to date − what the app has
 * already posted this fiscal year. A loss or sub-threshold profit
 * proposes nothing (and says why). The journal: Dr Corporate Tax Expense
 * / Cr Corporate Tax Provision (payable) — both accounts are company
 * settings; nothing is proposed until they are chosen.
 *
 * Accounting profit is a PROXY for taxable income — adjustments (exempt
 * income, disallowed expenses, reliefs) belong to the tax computation.
 * The note says so on every proposal.
 */

export interface CtSettings {
  rate: number;                 // percent, e.g. 9
  threshold: number;            // e.g. 375000
  expense_account_id: string | null;
  payable_account_id: string | null;
  expense_account_name?: string | null;
  payable_account_name?: string | null;
}
export interface CtResult {
  applicable: boolean;
  reason: string;
  net_profit_ytd: number;
  taxable_above_threshold: number;
  provision_to_date: number;
  already_provided: number;
  top_up: number;
  lines: Array<{ account_id: string; account_name: string | null; side: "D" | "C"; amount: number; description: string }> | null;
  notes: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeCtProvision(opts: {
  settings: CtSettings;
  net_profit_ytd: number;
  already_provided: number; // posted ct_provision journals this FY
  period: string;           // yyyy-mm
  fy_start: string;         // yyyy-mm-dd
}): CtResult {
  const s = opts.settings;
  const base = {
    net_profit_ytd: r2(opts.net_profit_ytd),
    already_provided: r2(opts.already_provided),
    lines: null as CtResult["lines"],
    notes: null as string | null,
  };
  if (!s.expense_account_id || !s.payable_account_id) {
    return { ...base, applicable: false, reason: "Corporate tax accounts are not chosen yet — pick the expense and provision accounts in settings before anything is proposed.", taxable_above_threshold: 0, provision_to_date: 0, top_up: 0 };
  }
  if (!(s.rate > 0)) {
    return { ...base, applicable: false, reason: "Corporate tax rate is zero — nothing to provide.", taxable_above_threshold: 0, provision_to_date: 0, top_up: 0 };
  }
  const taxable = Math.max(0, r2(opts.net_profit_ytd - s.threshold));
  const provisionToDate = r2(taxable * (s.rate / 100));
  const topUp = r2(provisionToDate - opts.already_provided);
  if (opts.net_profit_ytd <= 0) {
    return { ...base, applicable: true, reason: `Fiscal-year-to-date result is a loss (${base.net_profit_ytd.toFixed(2)}) — no provision needed.`, taxable_above_threshold: 0, provision_to_date: 0, top_up: 0 };
  }
  if (taxable <= 0) {
    return { ...base, applicable: true, reason: `Profit ${base.net_profit_ytd.toFixed(2)} is under the ${s.threshold.toFixed(0)} threshold — no provision needed.`, taxable_above_threshold: 0, provision_to_date: provisionToDate, top_up: 0 };
  }
  if (topUp <= 0) {
    return { ...base, applicable: true, reason: `Provision to date ${provisionToDate.toFixed(2)} is already covered by ${base.already_provided.toFixed(2)} posted this fiscal year — nothing further to provide.`, taxable_above_threshold: taxable, provision_to_date: provisionToDate, top_up: 0 };
  }
  return {
    ...base,
    applicable: true,
    reason: `Provision to date ${provisionToDate.toFixed(2)} (${s.rate}% of ${taxable.toFixed(2)} above the ${s.threshold.toFixed(0)} threshold), ${base.already_provided.toFixed(2)} already provided — top up ${topUp.toFixed(2)}.`,
    taxable_above_threshold: taxable,
    provision_to_date: provisionToDate,
    top_up: topUp,
    lines: [
      { account_id: s.expense_account_id, account_name: s.expense_account_name ?? null, side: "D", amount: topUp, description: `Corporate tax provision — ${opts.period}` },
      { account_id: s.payable_account_id, account_name: s.payable_account_name ?? null, side: "C", amount: topUp, description: `Corporate tax provision — ${opts.period}` },
    ],
    notes: `Corporate tax provision for ${opts.period}: ${s.rate}% on fiscal-year-to-date profit above ${s.threshold.toFixed(0)} (profit ${base.net_profit_ytd.toFixed(2)} since ${opts.fy_start}), minus ${base.already_provided.toFixed(2)} already provided. Accounting profit is a proxy for taxable income — the tax computation (exempt income, disallowed expenses, reliefs) is the accountant's. Confirmed by a reviewer before posting.`,
  };
}

/** Walk Zoho's P&L report tree and return the "Net Profit/Loss" total. */
export function netProfitFromReport(sections: Array<{ name?: string; total?: number }>): number | null {
  for (const s of sections ?? []) {
    if (/net profit/i.test(String(s.name ?? ""))) return Number(s.total ?? 0) || 0;
  }
  return null;
}

/** Fiscal year start for a date (fiscal_year_start_month: 1–12; "january" = 1). */
export function fiscalYearStart(date: string, startMonth: number): string {
  const [y, m] = date.split("-").map(Number);
  const sm = Math.max(1, Math.min(12, startMonth || 1));
  const year = m >= sm ? y : y - 1;
  return `${year}-${String(sm).padStart(2, "0")}-01`;
}
