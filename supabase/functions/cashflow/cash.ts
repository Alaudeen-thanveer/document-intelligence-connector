/**
 * Cash: collections, payment run, credit control — pure.
 *
 * COLLECTIONS (item 13). Ageing buckets over the open invoices, and "who
 * to chase this week": an invoice makes the chase list when it is overdue
 * by the calendar, OR when the customer is later than their own learned
 * habit (payment lags from layer 6 — median/p90 days from invoice date).
 * Ranked by money × lateness. Each row says why in plain words and, when
 * the invoice is actually overdue, offers Zoho's own payment reminder
 * (POST /invoices/{id}/paymentreminder — an email Zoho sends; a human
 * clicks per invoice, nothing is sent on a schedule).
 *
 * PAYMENT RUN (item 14). "Which bills to pay this week": everything
 * overdue plus bills due within the horizon, grouped per vendor as a
 * proposed batch. The reviewer unticks what shouldn't go, picks the bank
 * account and date, and approval records vendor payments in Zoho — one
 * per vendor, applied to the chosen bills. A vendor holding unused credit
 * is flagged (apply the credit before paying cash).
 *
 * CREDIT CONTROL (item 15). Before a sales invoice goes out: the
 * customer's exposure (open balance + this invoice) against their limit.
 * The limit is Zoho's own credit_limit when the org has the feature on;
 * else the app-side map in company_config.credit_limits; no limit = the
 * check does not apply. Over the limit refuses with the numbers — a human
 * override (with a reason, audited) still posts.
 */

export interface OpenInvoiceLike {
  zoho_id: string;
  number: string;
  party_zoho_id: string;
  party_name: string;
  date: string;
  due_date: string | null;
  total: number;
  balance: number;
  currency: string | null;
}
export interface PayBehaviour { party_zoho_id: string; pay_lag_median: number | null; pay_lag_p90: number }

const r2 = (n: number) => Math.round(n * 100) / 100;
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// ---------------------------------------------------------------------------
// Ageing
// ---------------------------------------------------------------------------
export interface AgeingBucket { amount: number; count: number }
export interface Ageing {
  buckets: { current: AgeingBucket; d1_30: AgeingBucket; d31_60: AgeingBucket; d61_90: AgeingBucket; d90_plus: AgeingBucket };
  total: AgeingBucket;
}

export function ageInvoices(invoices: OpenInvoiceLike[], today: string): Ageing {
  const mk = (): AgeingBucket => ({ amount: 0, count: 0 });
  const b = { current: mk(), d1_30: mk(), d31_60: mk(), d61_90: mk(), d90_plus: mk() };
  const total = mk();
  for (const inv of invoices) {
    if (!(inv.balance > 0)) continue;
    const overdue = inv.due_date ? daysBetween(inv.due_date, today) : 0;
    const bucket = overdue <= 0 ? b.current : overdue <= 30 ? b.d1_30 : overdue <= 60 ? b.d31_60 : overdue <= 90 ? b.d61_90 : b.d90_plus;
    bucket.amount = r2(bucket.amount + inv.balance); bucket.count++;
    total.amount = r2(total.amount + inv.balance); total.count++;
  }
  return { buckets: b, total };
}

// ---------------------------------------------------------------------------
// Who to chase this week
// ---------------------------------------------------------------------------
export interface ChaseItem {
  invoice: OpenInvoiceLike;
  days_overdue: number;          // vs due date (negative = not yet due)
  days_late_vs_habit: number | null; // vs the customer's own p90 lag
  score: number;
  reason: string;
  can_remind: boolean;           // Zoho's reminder makes sense (actually overdue)
}

export function buildChaseList(invoices: OpenInvoiceLike[], behaviours: PayBehaviour[], today: string): ChaseItem[] {
  const byParty = new Map(behaviours.map((b) => [b.party_zoho_id, b]));
  const out: ChaseItem[] = [];
  for (const inv of invoices) {
    if (!(inv.balance > 0)) continue;
    const overdue = inv.due_date ? daysBetween(inv.due_date, today) : 0;
    const habit = byParty.get(inv.party_zoho_id) ?? null;
    const habitLate = habit && Number.isFinite(habit.pay_lag_p90) ? daysBetween(addDays(inv.date, habit.pay_lag_p90), today) : null;
    if (overdue <= 0 && (habitLate == null || habitLate <= 0)) continue;
    const worst = Math.max(overdue, habitLate ?? 0);
    let reason: string;
    if (overdue > 0 && habitLate != null && habitLate > 0) {
      reason = `${overdue} day${overdue === 1 ? "" : "s"} past due — and past ${inv.party_name}'s own habit too (they settle within ~${habit!.pay_lag_p90} days${habit!.pay_lag_median != null ? `, usually ~${habit!.pay_lag_median}` : ""}).`;
    } else if (overdue > 0) {
      reason = `${overdue} day${overdue === 1 ? "" : "s"} past the due date (${inv.due_date}).`;
    } else {
      reason = `Not due until ${inv.due_date ?? "—"}, but ${inv.party_name} usually settles within ~${habit!.pay_lag_p90} days of the invoice — that passed ${habitLate} day${habitLate === 1 ? "" : "s"} ago. Worth a friendly nudge.`;
    }
    out.push({ invoice: inv, days_overdue: overdue, days_late_vs_habit: habitLate, score: r2(inv.balance * Math.max(1, worst)), reason, can_remind: overdue > 0 });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Payment run
// ---------------------------------------------------------------------------
export interface UnusedCreditLike { party_zoho_id: string; kind: string; number: string; balance: number }
export interface PaymentRunBill { zoho_id: string; number: string; date: string; due_date: string | null; days_until_due: number | null; balance: number; pay_amount: number; currency: string | null }
export interface PaymentRunGroup {
  vendor_zoho_id: string;
  vendor_name: string;
  bills: PaymentRunBill[];
  total: number;
  currency: string | null;
  note: string | null; // unused credit warning
}

export function buildPaymentRun(bills: OpenInvoiceLike[], opts: { today: string; horizon_days: number; unused_credits?: UnusedCreditLike[] }): PaymentRunGroup[] {
  const horizonEnd = addDays(opts.today, Math.max(0, opts.horizon_days));
  const creditByVendor = new Map<string, UnusedCreditLike[]>();
  for (const c of opts.unused_credits ?? []) {
    if (!(c.balance > 0)) continue;
    creditByVendor.set(c.party_zoho_id, [...(creditByVendor.get(c.party_zoho_id) ?? []), c]);
  }
  const groups = new Map<string, PaymentRunGroup>();
  for (const b of bills) {
    if (!(b.balance > 0)) continue;
    const due = b.due_date ?? b.date; // no terms = due on the bill date
    if (due > horizonEnd) continue;
    const g = groups.get(b.party_zoho_id) ?? {
      vendor_zoho_id: b.party_zoho_id, vendor_name: b.party_name, bills: [], total: 0, currency: b.currency, note: null,
    };
    g.bills.push({ zoho_id: b.zoho_id, number: b.number, date: b.date, due_date: b.due_date, days_until_due: daysBetween(opts.today, due), balance: b.balance, pay_amount: b.balance, currency: b.currency });
    g.total = r2(g.total + b.balance);
    if (b.currency && g.currency && b.currency !== g.currency) g.currency = null; // mixed — one payment per currency won't work; the reviewer will see it
    groups.set(b.party_zoho_id, g);
  }
  for (const g of groups.values()) {
    g.bills.sort((a, b) => (a.days_until_due ?? 0) - (b.days_until_due ?? 0));
    const credits = creditByVendor.get(g.vendor_zoho_id) ?? [];
    if (credits.length) {
      const total = r2(credits.reduce((t, c) => t + c.balance, 0));
      g.note = `${g.vendor_name} holds ${total.toFixed(2)} unused credit (${credits.map((c) => `${c.kind} ${c.number}: ${c.balance.toFixed(2)}`).join(", ")}) — apply it to the bills before paying cash.`;
    }
  }
  // Most urgent group first (its most-overdue bill).
  return [...groups.values()].sort((a, b) => (a.bills[0]?.days_until_due ?? 0) - (b.bills[0]?.days_until_due ?? 0));
}

/** Validate one approved vendor-payment against the CURRENT open bills (never the client's numbers). */
export function validatePayment(
  payment: { vendor_id: string; date: string; bills: Array<{ bill_id: string; amount_applied: number }> },
  openBills: OpenInvoiceLike[],
  opts: { today: string; locked_until: string | null },
): { ok: true; total: number; vendor_name: string } | { ok: false; error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payment.date)) return { ok: false, error: "Payment date must be yyyy-mm-dd." };
  if (opts.locked_until && payment.date <= opts.locked_until) return { ok: false, error: `The books are locked through ${opts.locked_until} — a payment dated ${payment.date} cannot go in.` };
  if (!payment.bills.length) return { ok: false, error: "No bills chosen." };
  let total = 0; let vendorName = "";
  for (const b of payment.bills) {
    const open = openBills.find((x) => x.zoho_id === b.bill_id);
    if (!open) return { ok: false, error: `Bill ${b.bill_id} is not open any more — refresh the run.` };
    if (open.party_zoho_id !== payment.vendor_id) return { ok: false, error: `Bill ${open.number} belongs to ${open.party_name}, not the vendor being paid.` };
    const amt = r2(Number(b.amount_applied));
    if (!(amt > 0)) return { ok: false, error: `Bill ${open.number}: the amount must be above zero.` };
    if (amt > open.balance + 0.005) return { ok: false, error: `Bill ${open.number}: ${amt.toFixed(2)} is more than the ${open.balance.toFixed(2)} open on it.` };
    total = r2(total + amt);
    vendorName = open.party_name;
  }
  return { ok: true, total, vendor_name: vendorName };
}

// ---------------------------------------------------------------------------
// Credit control
// ---------------------------------------------------------------------------
export interface CreditCheckResult {
  applicable: boolean;
  over: boolean;
  limit: number | null;
  limit_source: "zoho" | "app" | null;
  outstanding: number;
  invoice_total: number;
  exposure_after: number;
  headroom_before: number | null;
  unused_credits: number;
  note: string;
}

export function creditCheck(opts: {
  customer_name: string;
  zoho_credit_limit: number | null;   // Zoho's own field (when the org enables it)
  app_credit_limit: number | null;    // company_config.credit_limits fallback
  outstanding: number;                // open receivable balance now
  unused_credits: number;             // advances / credit notes they hold
  invoice_total: number;              // the invoice about to go out
}): CreditCheckResult {
  const limit = opts.zoho_credit_limit && opts.zoho_credit_limit > 0 ? opts.zoho_credit_limit : opts.app_credit_limit && opts.app_credit_limit > 0 ? opts.app_credit_limit : null;
  const source: CreditCheckResult["limit_source"] = limit == null ? null : (opts.zoho_credit_limit && opts.zoho_credit_limit > 0 ? "zoho" : "app");
  const exposureAfter = r2(opts.outstanding + opts.invoice_total);
  const base = { limit, limit_source: source, outstanding: r2(opts.outstanding), invoice_total: r2(opts.invoice_total), exposure_after: exposureAfter, unused_credits: r2(opts.unused_credits) };
  if (limit == null) {
    return { ...base, applicable: false, over: false, headroom_before: null, note: `No credit limit set for ${opts.customer_name} — nothing to enforce. Set one in Zoho Books (Customer Credit Limits) or in the app's credit limits.` };
  }
  const headroom = r2(limit - opts.outstanding);
  if (exposureAfter > limit + 0.005) {
    const creditNote = opts.unused_credits > 0 ? ` They do hold ${opts.unused_credits.toFixed(2)} unused credit — applying it first may bring them back inside.` : "";
    return { ...base, applicable: true, over: true, headroom_before: headroom, note: `${opts.customer_name} would be over their ${limit.toFixed(2)} limit: ${opts.outstanding.toFixed(2)} already open + this ${opts.invoice_total.toFixed(2)} = ${exposureAfter.toFixed(2)}.${creditNote}` };
  }
  return { ...base, applicable: true, over: false, headroom_before: headroom, note: `${opts.customer_name} stays inside their ${limit.toFixed(2)} limit — ${r2(limit - exposureAfter).toFixed(2)} headroom after this invoice.` };
}
