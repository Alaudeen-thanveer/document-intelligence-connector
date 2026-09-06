/** What the review UI (or a sibling function) sends to zoho-push. */
import type { ZohoAccount, ZohoVendor } from "./match-entities.ts";

export interface PushInput {
  document_id: string;
  /** Optional expense category hint for GL matching. */
  expense_category?: string | null;
  /** Cached Zoho vendors; falls back to ZOHO_VENDORS_JSON env or live API. */
  vendors?: ZohoVendor[];
  /** Cached chart of accounts; falls back to ZOHO_ACCOUNTS_JSON env or live API. */
  accounts?: ZohoAccount[];
  /** How to post into Zoho Books; defaults to "bill". */
  post_as?: "bill" | "invoice" | "expense";
  /** Explicit Zoho vendor contact id chosen in the review UI (bill/expense). */
  vendor_id?: string | null;
  /** Explicit Zoho customer contact id chosen in the review UI (invoice). */
  customer_id?: string | null;
  /** Explicit GL account id chosen in the review UI. */
  account_id?: string | null;
  /** Bank/cash account the expense was paid through (expense only). */
  paid_through_account_id?: string | null;
  /**
   * Unused credit the reviewer chose to apply once the document exists:
   * advances (unused customer/vendor payments) and credit notes / vendor
   * credits. Applied AFTER a successful create; a failure here never undoes
   * the document — it is reported in the response instead.
   */
  apply_credits?: Array<{
    kind: "customerpayment" | "creditnote" | "vendorpayment" | "vendorcredit";
    zoho_id: string;
    amount: number;
  }> | null;
  /**
   * VAT treatment for THIS transaction (e.g. vat_registered, out_of_scope).
   * Treatment is transactional, not just party-level — a VAT-registered
   * vendor can still have an out-of-scope bill. When omitted, Zoho applies
   * the contact's own default treatment.
   */
  tax_treatment?: string | null;
}
