/**
 * Layer 6: timing / payment behaviour per party. Pure — no I/O.
 * See docs/BOOKKEEPING_PATTERNS_SPEC.md §3.7.
 *
 * Learns, per vendor (bills + vendor payments) and per customer (invoices +
 * customer payments): how long after the document date it was entered, how
 * long until it was paid, how that compares to nominal payment terms, and
 * the usual payment mode / account. Proposals only — surfaced as evidence
 * and as month-end "later than usual" nudges once a human enables them.
 */

export interface TimingDoc {
  doc_kind: "bill" | "invoice";
  zoho_id: string;
  party_zoho_id: string;
  party_name: string;
  /** Document date as printed. */
  date: string; // yyyy-mm-dd
  /** When the accountant entered it in Zoho (created_time date part). */
  entered_date: string | null;
  due_date: string | null;
  /** Nominal terms in days when Zoho gives them (payment_terms). */
  terms_days: number | null;
  total: number;
  balance: number;
  status: string; // paid / open / overdue / partially_paid / void / draft
}

export interface PaymentDoc {
  payment_id: string;
  party_zoho_id: string;
  date: string;
  amount: number;
  payment_mode: string | null;
  account_id: string | null;
  account_name: string | null;
  /** Documents this payment settled: doc zoho_id → amount applied. */
  applied: Array<{ doc_zoho_id: string; amount: number }>;
}

export interface TimingProfile {
  party_kind: "vendor" | "customer";
  party_zoho_id: string;
  party_name: string;
  /** Days from document date to entry in Zoho. */
  entry_lag_median: number | null;
  entry_lag_p90: number | null;
  /** Days from document date to (final) payment. Actual DPO / DSO. */
  pay_lag_median: number | null;
  pay_lag_p10: number | null;
  pay_lag_p90: number | null;
  /** Nominal terms mode, when known. */
  terms_days_mode: number | null;
  /** Actual vs nominal: positive = pays later than terms. */
  pays_vs_terms_days: number | null;
  /** Share of PAID docs settled before / on / after due date. */
  early_share: number | null;
  on_time_share: number | null;
  late_share: number | null;
  /** Usual payment mode and account. */
  payment_mode_mode: string | null;
  payment_account_id: string | null;
  payment_account_name: string | null;
  /** Docs considered / docs with a payment lag. */
  sample_size: number;
  paid_sample_size: number;
  confidence: number;
}

export const MIN_TIMING_SAMPLE = 3;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}
function mode<T extends string | number>(values: Array<T | null>): T | null {
  const counts = new Map<T, number>();
  for (const v of values) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [v, k] of counts) if (k > n) { best = v; n = k; }
  return best;
}
function evidence(n: number): number {
  return 1 - Math.exp(-n / 8);
}
const isDate = (s: string | null | undefined): s is string =>
  !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Build one timing profile per party. Payment lag uses the LAST payment
 * that touched a document (final settlement); partially-paid documents
 * are excluded from the lag stats but counted in sample_size.
 */
export function buildTimingProfiles(
  docs: TimingDoc[],
  payments: PaymentDoc[],
): TimingProfile[] {
  // doc zoho_id → last payment date + the payment itself
  const lastPayment = new Map<string, PaymentDoc>();
  for (const p of payments) {
    for (const a of p.applied) {
      const prev = lastPayment.get(a.doc_zoho_id);
      if (!prev || p.date > prev.date) lastPayment.set(a.doc_zoho_id, p);
    }
  }

  const groups = new Map<string, TimingDoc[]>();
  for (const d of docs) {
    if (!d.party_zoho_id || !isDate(d.date)) continue;
    if (d.status === "void" || d.status === "draft") continue;
    const kind = d.doc_kind === "bill" ? "vendor" : "customer";
    const key = `${kind}:${d.party_zoho_id}`;
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }

  const out: TimingProfile[] = [];
  for (const [key, list] of groups) {
    const party_kind = key.startsWith("vendor:") ? "vendor" : "customer";
    const entryLags: number[] = [];
    const payLags: number[] = [];
    let early = 0, onTime = 0, late = 0;
    const modes: Array<string | null> = [];
    const accts: Array<string | null> = [];
    const acctNames = new Map<string, string>();
    const terms: Array<number | null> = [];
    let paidCount = 0;

    for (const d of list) {
      if (isDate(d.entered_date)) entryLags.push(daysBetween(d.date, d.entered_date));
      if (d.terms_days != null) terms.push(d.terms_days);
      const isPaid = d.status === "paid" || (d.balance === 0 && d.total > 0);
      const pay = lastPayment.get(d.zoho_id);
      if (isPaid && pay && isDate(pay.date)) {
        paidCount++;
        payLags.push(daysBetween(d.date, pay.date));
        modes.push(pay.payment_mode);
        accts.push(pay.account_id);
        if (pay.account_id && pay.account_name) acctNames.set(pay.account_id, pay.account_name);
        if (isDate(d.due_date)) {
          const vsDue = daysBetween(d.due_date, pay.date);
          if (vsDue < 0) early++;
          else if (vsDue === 0) onTime++;
          else late++;
        }
      }
    }

    entryLags.sort((a, b) => a - b);
    payLags.sort((a, b) => a - b);
    const termsMode = mode(terms);
    const payMedian = percentile(payLags, 0.5);
    const dueDenom = early + onTime + late;
    const acctMode = mode(accts);

    out.push({
      party_kind,
      party_zoho_id: list[0].party_zoho_id,
      party_name: list[0].party_name,
      entry_lag_median: percentile(entryLags, 0.5),
      entry_lag_p90: percentile(entryLags, 0.9),
      pay_lag_median: payMedian,
      pay_lag_p10: percentile(payLags, 0.1),
      pay_lag_p90: percentile(payLags, 0.9),
      terms_days_mode: termsMode,
      pays_vs_terms_days: payMedian != null && termsMode != null
        ? Math.round(payMedian - termsMode)
        : null,
      early_share: dueDenom ? Math.round((early / dueDenom) * 1000) / 1000 : null,
      on_time_share: dueDenom ? Math.round((onTime / dueDenom) * 1000) / 1000 : null,
      late_share: dueDenom ? Math.round((late / dueDenom) * 1000) / 1000 : null,
      payment_mode_mode: mode(modes),
      payment_account_id: acctMode,
      payment_account_name: acctMode ? acctNames.get(acctMode) ?? null : null,
      sample_size: list.length,
      paid_sample_size: paidCount,
      confidence: Math.round(evidence(paidCount) * 1000) / 1000,
    });
  }
  return out.sort((a, b) => b.sample_size - a.sample_size);
}

export function isTimingProposable(p: TimingProfile): boolean {
  return p.paid_sample_size >= MIN_TIMING_SAMPLE && p.pay_lag_median != null;
}

/**
 * Month-end nudge helper: an OPEN document is "later than usual" when it
 * has been outstanding longer than this party's p90 payment lag.
 */
export function laterThanUsual(
  profile: TimingProfile,
  docDate: string,
  today: string,
): { later: boolean; days_open: number; usual_p90: number | null } {
  const days_open = daysBetween(docDate, today);
  const usual_p90 = profile.pay_lag_p90;
  return {
    later: usual_p90 != null && days_open > usual_p90,
    days_open,
    usual_p90,
  };
}
