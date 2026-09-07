/**
 * The shapes zoho-approve speaks: what the review UI sends, what it gets
 * back, and the outcome of checking the lines against the total.
 */
import type { EInvoiceFinding } from "./einvoice.ts";
import type { CreditCheckResult } from "../cashflow/cash.ts";
import type { Followups } from "../month-end/schedules.ts";

export type PostAs = "bill" | "invoice" | "expense";

export interface ApproveInput {
  invoice_id?: string;
  post_as?: PostAs;
  vendor_id?: string | null;
  customer_id?: string | null;
  account_id?: string | null;
  paid_through_account_id?: string | null;
  tax_treatment?: string | null;
  /**
   * Unused credit the reviewer chose to apply once the document exists
   * (advances = unused payments, credit notes / vendor credits). Applied
   * AFTER a successful create; a failure here never undoes the document —
   * it is reported in the response.
   */
  apply_credits?: Array<{
    kind: "customerpayment" | "creditnote" | "vendorpayment" | "vendorcredit";
    zoho_id: string;
    amount: number;
  }> | null;
  /**
   * Human override of a failed judgment. Without it, a document whose
   * latest checks include a failure is refused (409) with the failed checks
   * listed. With it, the reason is written to audit_log.
   */
  override?: boolean;
  override_reason?: string | null;
  /**
   * Human override of the line reconciliation guard. Without it, a document
   * whose extracted lines do not add up to its extracted total is refused.
   * With it, ONE line at the document total is posted (never the broken
   * lines), and the reason is audited.
   */
  override_reconciliation?: boolean;
  /** UAE VAT: emirate code for sales invoices; defaults to the customer's place_of_contact. */
  place_of_supply?: string | null;
  /**
   * Purchase order to link the bill to (Zoho purchaseorder_id). When absent
   * the PO is resolved from the bill's extracted PO number against the
   * synced open POs; "" / null disables linking.
   */
  purchaseorder_id?: string | null;
}

export interface ApproveResult {
  success: boolean;
  zoho_bill_id?: string;
  error?: string;
  credits_applied?: { applied: number; ok: boolean; response?: unknown } | null;
  purchase_order?: { zoho_id: string; number: string; how: "input" | "po_number" } | null;
  /** UAE e-invoice field readiness (sales invoices only) — informs, never issues. */
  einvoice?: { findings: EInvoiceFinding[]; ready: boolean } | null;
  /** Credit control (sales invoices only): exposure vs limit. */
  credit?: CreditCheckResult | null;
  /** Bill lines that deserve a follow-up: an asset record / a prepayment schedule. */
  followups?: Followups | null;
  failed_checks?: Array<{ rule_name: string; notes: string | null }>;
  reconciliation?: Reconciliation;
  money?: { tax_id: string | null; tax_name: string | null; currency_id: string | null; notes: string[] };
  attachment?: { uploaded: boolean; filename?: string; error?: string };
  already_synced?: boolean;
}

/** Outcome of checking Σ extracted lines against the extracted total. */
export interface Reconciliation {
  ok: boolean;
  /** net: lines + VAT = total · gross: lines = total (VAT inside) · implicit: no usable lines, one line at the total */
  mode: "net" | "gross" | "implicit" | "mismatch";
  lines_total: number;
  tax_amount: number;
  document_total: number;
  dropped_lines: number[];
  message: string;
}
