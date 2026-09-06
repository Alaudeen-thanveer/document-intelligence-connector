/**
 * Bank feed mode — pure pieces.
 *
 * In feed mode the statement lines already live in Zoho Books as
 * UNCATEGORISED transactions (from a bank feed or a statement import). We
 * pull them, suggest with the same engine, and act with Zoho's own verbs:
 *
 *   match      POST /banktransactions/uncategorized/{id}/match
 *              { transactions_to_be_matched: [{ transaction_id, transaction_type }] }
 *              (verified live — the docs say "transactions"; Zoho rejects that)
 *   categorize POST /banktransactions/uncategorized/{id}/categorize/{kind}
 *              (customerpayments · vendorpayments · expenses ·
 *               creditnoterefunds · vendorcreditrefunds · paymentrefunds ·
 *               vendorpaymentrefunds) or the generic …/categorize for
 *              deposits / transfers / other income
 *   exclude    POST /banktransactions/uncategorized/{id}/exclude
 *              (Zoho then lists the line under filter_by=Status.Excluded with
 *              status "deleted" — it is out of the books but not gone)
 *
 * Zoho keeps the statement and the reconciliation; nothing is created
 * standalone, so there is exactly one copy of every line.
 */
import type { Suggestion } from "./suggest.ts";

/** One row of GET /banktransactions/uncategorized. */
export interface ZohoUncategorizedRow {
  transaction_id: string;
  date: string;
  amount: number | string;
  debit_or_credit: string;
  payee?: string | null;
  description?: string | null;
  reference_number?: string | null;
  status?: string | null;
  imported_transaction_id?: string | null;
}

/** One row of GET /banktransactions/uncategorized/{id}/match. */
export interface ZohoMatchCandidate {
  transaction_id: string;
  transaction_type: string; // customer_payment | vendor_payment | expense | transfer_fund | …
  date: string;
  amount: number | string;
  contact_name?: string | null;
  reference_number?: string | null;
  debit_or_credit?: string | null;
  /** Zoho's own ranking flags on match candidates. */
  is_best_match?: boolean;
  is_exact_match?: boolean;
  transaction_number?: string | null;
}

export interface FeedLine {
  line_no: number;
  txn_date: string;
  value_date: string | null;
  description: string;
  reference: string | null;
  side: "debit" | "credit";
  amount: number;
  balance: null;
  zoho_uncategorized_id: string;
  zoho_payee: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Zoho uncategorised rows → our line shape. Description falls back to payee, then reference. */
export function uncategorizedToLines(rows: ZohoUncategorizedRow[]): FeedLine[] {
  return rows
    .filter((r) => r && r.transaction_id && r.date)
    .map((r, i): FeedLine => {
      const description = [r.description, r.payee, r.reference_number].map((x) => (x == null ? "" : String(x).trim())).find(Boolean) ?? `Zoho transaction ${r.transaction_id}`;
      return {
        line_no: i + 1,
        txn_date: String(r.date).slice(0, 10),
        value_date: null,
        description,
        reference: r.reference_number ? String(r.reference_number).trim() || null : null,
        // Zoho reports debit_or_credit from the LEDGER's view: money leaving
        // the bank is a CREDIT to the bank account. Our side is the
        // statement's view: money out = debit. Invert.
        side: String(r.debit_or_credit ?? "").toLowerCase() === "credit" ? "debit" : "credit",
        amount: r2(Math.abs(Number(r.amount) || 0)),
        balance: null,
        zoho_uncategorized_id: String(r.transaction_id),
        zoho_payee: r.payee ? String(r.payee) : null,
      };
    })
    .filter((l) => l.amount > 0);
}

/** Zoho transaction_type → our ref_kind, and back. */
export function refKindForZohoType(t: string): Suggestion["ref_kind"] {
  const s = String(t).toLowerCase();
  if (s === "customer_payment") return "customerpayment";
  if (s === "vendor_payment") return "vendorpayment";
  if (s === "expense") return "expense";
  return "banktransaction";
}
export function zohoTypeForRefKind(k: string | null | undefined, fallback = "expense"): string {
  if (k === "customerpayment") return "customer_payment";
  if (k === "vendorpayment") return "vendor_payment";
  if (k === "expense") return "expense";
  return fallback;
}

/**
 * Zoho's own match candidates for a line → an "already recorded"
 * suggestion when one fits the amount (and, when Zoho tells us, the side).
 * Zoho already filtered by the bank account; we keep its ranking. This
 * takes precedence over creating anything — it is the duplicate control
 * in feed mode.
 */
/** Zoho match candidates that are RECORDED MONEY (not open documents — those are "apply to", handled by allocation). */
const MONEY_TYPES = new Set(["customer_payment", "vendor_payment", "expense", "transfer_fund", "card_payment", "deposit", "refund", "sales_without_invoices", "expense_refund", "owner_contribution", "owner_drawings", "interest_income", "other_income", "journal", "retainer_payment"]);

export function suggestFromZohoMatches(
  line: { txn_date: string; amount: number; side: "debit" | "credit" },
  candidates: ZohoMatchCandidate[],
  windowDays: number,
): Suggestion | null {
  const day = (d: string) => new Date(d + "T00:00:00Z").getTime();
  const ageDays = (c: ZohoMatchCandidate) => c.date ? Math.abs(day(String(c.date).slice(0, 10)) - day(line.txn_date)) / 86_400_000 : 0;
  // Payments are dated when made and can reach the statement weeks later;
  // an expense or transfer of the same amount a month apart is far more
  // likely a DIFFERENT, recurring item (this month's bank fee vs last).
  const windowFor = (c: ZohoMatchCandidate) => /payment/.test(c.transaction_type) ? Math.max(windowDays, 30) : Math.max(windowDays, 7);
  const fits = candidates
    .filter((c) => MONEY_TYPES.has(String(c.transaction_type).toLowerCase()))
    .filter((c) => Math.abs((Number(c.amount) || 0) - line.amount) <= 0.05)
    .filter((c) => ageDays(c) <= windowFor(c))
    // Zoho's own ranking first (exact, then best match), then nearest date.
    .sort((a, b) => Number(Boolean(b.is_exact_match)) - Number(Boolean(a.is_exact_match)) || Number(Boolean(b.is_best_match)) - Number(Boolean(a.is_best_match)) || ageDays(a) - ageDays(b));
  if (!fits.length) return null;
  const c = fits[0];
  const kind = refKindForZohoType(c.transaction_type);
  const label = c.transaction_type.replace(/_/g, " ");
  const amountOnly = !c.contact_name && !c.reference_number && !c.is_exact_match;
  return {
    txn_kind: "already_recorded",
    party_kind: kind === "customerpayment" ? "customer" : kind === "vendorpayment" || kind === "expense" ? "vendor" : null,
    party_zoho_id: null,
    party_name: c.contact_name ?? null,
    account_id: null, account_name: null,
    doc_kind: null, doc_zoho_id: null, doc_number: null, doc_balance: null,
    allocations: [], advance_amount: 0, bank_charges: 0, residual: 0, writeoff: null,
    ref_kind: kind, ref_zoho_id: String(c.transaction_id), ref_number: c.reference_number ?? null,
    candidates: [],
    confidence: amountOnly ? 0.7 : fits.length === 1 ? 0.95 : 0.85,
    source: "already_recorded",
    reason: `Zoho Books already holds a ${label} of ${line.amount.toFixed(2)}${c.contact_name ? ` for ${c.contact_name}` : ""}${c.date ? ` dated ${String(c.date).slice(0, 10)}` : ""} — match this line to it, don't create another${amountOnly ? " (amount and date only — check it is the same item, not a recurring one)" : ""}${fits.length > 1 ? ` (${fits.length} candidates; nearest date shown)` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Push bodies — what Zoho receives for a confirmed feed line
// ---------------------------------------------------------------------------

export interface FeedConfirmed {
  txn_date: string;
  description: string;
  reference: string | null;
  side: "debit" | "credit";
  amount: number;
  zoho_uncategorized_id: string;
  chosen_txn_kind: string;
  chosen_party_kind: string | null;
  chosen_party_zoho_id: string | null;
  chosen_account_id: string | null;
  chosen_doc_kind: string | null;
  chosen_doc_zoho_id: string | null;
  chosen_allocations: Array<{ doc_kind: string; doc_zoho_id: string; amount_applied: number }> | null;
  chosen_bank_charges: number | null;
  chosen_ref_kind: string | null;
  chosen_ref_zoho_id: string | null;
  /** transaction_type of the matched Zoho record, when the suggestion came from Zoho's candidates */
  matched_transaction_type?: string | null;
}

export interface FeedRequest {
  /** relative to /banktransactions/uncategorized/{id} */
  path: string;
  body: Record<string, unknown> | null;
  /** what we expect Zoho to create/link — for the log */
  kind: string;
}

export function buildFeedRequest(line: FeedConfirmed, bankAccountId: string, taxIdForBankCharges?: string | null): FeedRequest {
  const id = encodeURIComponent(line.zoho_uncategorized_id);
  const base = `banktransactions/uncategorized/${id}`;
  const amount = r2(Number(line.amount));
  const common = { date: line.txn_date, reference_number: (line.reference ?? "").slice(0, 100) || undefined, description: line.description.slice(0, 500) };
  const allocs = (line.chosen_allocations ?? []).filter((a) => a.doc_zoho_id && Number(a.amount_applied) > 0);
  const kind = line.chosen_txn_kind;

  if (kind === "exclude") return { path: `${base}/exclude`, body: null, kind };

  if (kind === "already_recorded") {
    if (!line.chosen_ref_zoho_id) throw new Error("match needs the Zoho transaction to match");
    const type = line.matched_transaction_type || zohoTypeForRefKind(line.chosen_ref_kind);
    return { path: `${base}/match`, body: { transactions_to_be_matched: [{ transaction_id: line.chosen_ref_zoho_id, transaction_type: type }] }, kind: "match" };
  }

  if (kind === "customer_payment" || kind === "retainer_receipt") {
    if (!line.chosen_party_zoho_id) throw new Error("customer receipt needs a customer");
    if (line.side !== "credit") throw new Error("a customer receipt must be money IN");
    const charges = r2(Number(line.chosen_bank_charges ?? 0));
    const body: Record<string, unknown> = { customer_id: line.chosen_party_zoho_id, payment_mode: "banktransfer", amount: r2(amount + charges), account_id: bankAccountId, ...common };
    if (charges > 0) body.bank_charges = charges;
    if (kind === "retainer_receipt") body.retainerinvoice_id = line.chosen_ref_zoho_id ?? line.chosen_doc_zoho_id;
    else if (allocs.length) body.invoices = allocs.filter((a) => a.doc_kind === "invoice").map((a) => ({ invoice_id: a.doc_zoho_id, amount_applied: r2(Number(a.amount_applied)) }));
    else if (line.chosen_doc_kind === "invoice" && line.chosen_doc_zoho_id) body.invoices = [{ invoice_id: line.chosen_doc_zoho_id, amount_applied: amount }];
    return { path: `${base}/categorize/customerpayments`, body, kind: "customer_payment" };
  }

  if (kind === "vendor_payment") {
    if (!line.chosen_party_zoho_id) throw new Error("vendor payment needs a vendor");
    if (line.side !== "debit") throw new Error("a vendor payment must be money OUT");
    const charges = r2(Number(line.chosen_bank_charges ?? 0));
    if (charges > 0) {
      // One uncategorised line cannot become two Zoho records. The payment
      // is the line minus the charge; Zoho keeps the remainder unapplied.
      throw new Error(`this line carries ${charges.toFixed(2)} of bank charges on a vendor payment — in feed mode Zoho cannot split one line into a payment and an expense; categorise the payment here without the charge, then record the charge in Zoho`);
    }
    const body: Record<string, unknown> = { vendor_id: line.chosen_party_zoho_id, payment_mode: "banktransfer", amount, paid_through_account_id: bankAccountId, ...common };
    if (allocs.length) body.bills = allocs.filter((a) => a.doc_kind === "bill").map((a) => ({ bill_id: a.doc_zoho_id, amount_applied: r2(Number(a.amount_applied)) }));
    else if (line.chosen_doc_kind === "bill" && line.chosen_doc_zoho_id) body.bills = [{ bill_id: line.chosen_doc_zoho_id, amount_applied: amount }];
    return { path: `${base}/categorize/vendorpayments`, body, kind: "vendor_payment" };
  }

  if (kind === "expense") {
    if (!line.chosen_account_id) throw new Error("expense needs an account");
    if (line.side !== "debit") throw new Error("an expense must be money OUT");
    const body: Record<string, unknown> = { account_id: line.chosen_account_id, amount, paid_through_account_id: bankAccountId, ...common };
    if (line.chosen_party_kind === "vendor" && line.chosen_party_zoho_id) body.vendor_id = line.chosen_party_zoho_id;
    if (taxIdForBankCharges) body.tax_id = taxIdForBankCharges;
    return { path: `${base}/categorize/expenses`, body, kind: "expense" };
  }

  if (kind === "creditnote_refund" || kind === "payment_refund" || kind === "vendorcredit_refund" || kind === "vendorpayment_refund") {
    if (!line.chosen_ref_zoho_id) throw new Error("a refund needs the credit or payment being refunded");
    const refund = { refund_mode: "banktransfer", amount, date: line.txn_date, reference_number: common.reference_number, description: common.description };
    if (kind === "creditnote_refund") { if (line.side !== "debit") throw new Error("a credit-note refund is money OUT"); return { path: `${base}/categorize/creditnoterefunds`, body: { creditnote_id: line.chosen_ref_zoho_id, from_account_id: bankAccountId, ...refund }, kind }; }
    if (kind === "payment_refund") { if (line.side !== "debit") throw new Error("a payment refund is money OUT"); return { path: `${base}/categorize/paymentrefunds`, body: { payment_id: line.chosen_ref_zoho_id, from_account_id: bankAccountId, ...refund }, kind }; }
    if (kind === "vendorcredit_refund") { if (line.side !== "credit") throw new Error("a vendor-credit refund is money IN"); return { path: `${base}/categorize/vendorcreditrefunds`, body: { vendor_credit_id: line.chosen_ref_zoho_id, account_id: bankAccountId, ...refund }, kind }; }
    if (line.side !== "credit") throw new Error("a vendor-payment refund is money IN");
    return { path: `${base}/categorize/vendorpaymentrefunds`, body: { payment_id: line.chosen_ref_zoho_id, account_id: bankAccountId, ...refund }, kind };
  }

  if (kind === "deposit" || kind === "transfer" || kind === "other") {
    if (!line.chosen_account_id) throw new Error(`${kind} needs an account`);
    let body: Record<string, unknown>;
    if (kind === "deposit") {
      body = { transaction_type: "deposit", from_account_id: line.chosen_account_id, to_account_id: bankAccountId, amount, payment_mode: "banktransfer", ...common };
      if (line.chosen_party_kind === "customer" && line.chosen_party_zoho_id) body.customer_id = line.chosen_party_zoho_id;
    } else if (kind === "transfer") {
      body = line.side === "debit"
        ? { transaction_type: "transfer_fund", from_account_id: bankAccountId, to_account_id: line.chosen_account_id, amount, ...common }
        : { transaction_type: "transfer_fund", from_account_id: line.chosen_account_id, to_account_id: bankAccountId, amount, ...common };
    } else {
      body = line.side === "debit"
        ? { transaction_type: "owner_drawings", from_account_id: bankAccountId, to_account_id: line.chosen_account_id, amount, ...common }
        : { transaction_type: "other_income", from_account_id: line.chosen_account_id, to_account_id: bankAccountId, amount, ...common };
    }
    return { path: `${base}/categorize`, body, kind };
  }

  throw new Error("choose what this line is (match, receipt, payment, refund, expense, deposit, transfer or exclude) before categorising");
}

/** Pull the created/linked id out of whatever Zoho answers for a categorize/match. */
export function extractZohoId(raw: Record<string, unknown>): string | null {
  const cands: Array<Record<string, unknown> | undefined> = [
    raw.banktransaction as Record<string, unknown>, raw.payment as Record<string, unknown>, raw.vendorpayment as Record<string, unknown>,
    raw.expense as Record<string, unknown>, raw.creditnote_refund as Record<string, unknown>, raw.vendor_credit_refund as Record<string, unknown>,
    raw.payment_refund as Record<string, unknown>, raw.vendorpayment_refund as Record<string, unknown>, raw.transaction as Record<string, unknown>,
  ];
  for (const c of cands) {
    if (!c) continue;
    for (const k of ["transaction_id", "payment_id", "expense_id", "creditnote_refund_id", "vendor_credit_refund_id", "payment_refund_id", "vendorpayment_refund_id"]) {
      if (c[k] != null && String(c[k])) return String(c[k]);
    }
  }
  return null;
}
