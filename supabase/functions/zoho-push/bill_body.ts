/** The bill as Zoho's create call takes it, built from the mapped document. */
import type { ZohoBillMapped } from "./mapping.ts";

/** One line of the bill as Zoho's create call takes it. */
type ZohoBillLine = {
  description: string;
  rate: number;
  quantity: number;
  account_id: string;
  tax_id?: string;
  project_id?: string;
  tags?: Array<{ tag_id: string; tag_option_id: string }>;
};

/**
 * The bill as sent to Zoho. A type alias rather than an interface so it
 * still satisfies the Record<string, unknown> the HTTP helpers take.
 */
type ZohoBillBody = {
  vendor_id: string;
  bill_number: string;
  date: string;
  due_date?: string;
  reference_number?: string;
  line_items: ZohoBillLine[];
};

export function toZohoBillBody(
  bill: ZohoBillMapped,
  opts?: { billNumber?: string },
): ZohoBillBody {
  if (!bill.vendor_id) {
    throw new Error("vendor_id is required before Zoho push");
  }
  // Many Zoho orgs (esp. India) require an explicit bill_number when
  // auto-generation is off — omit/invalid values return code 4.
  const billNumber = (opts?.billNumber ?? "").trim() ||
    `DIC-${Date.now()}`;

  return {
    vendor_id: bill.vendor_id,
    bill_number: billNumber,
    date: bill.date,
    ...(bill.due_date ? { due_date: bill.due_date } : {}),
    ...(bill.reference_number
      ? { reference_number: bill.reference_number }
      : {}),
    line_items: bill.line_items.map((item): ZohoBillLine => {
      // Refused here, before anything is sent: a line with no account
      // cannot be posted, and Zoho's own error for it is unhelpful.
      const accountId = item.account_id;
      if (!accountId) {
        throw new Error("account_id is required on line items before Zoho push");
      }
      return {
        description: item.description,
        rate: item.rate,
        quantity: item.quantity,
        account_id: accountId,
        ...(item.tax_id ? { tax_id: item.tax_id } : {}),
        ...(item.project_id ? { project_id: item.project_id } : {}),
        ...(item.tags && item.tags.length > 0 ? { tags: item.tags } : {}),
      };
    }),
  };
}
