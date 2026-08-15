/**
 * Pure mapping: extracted_fields row → Zoho Books Bill API shape.
 *
 * Field renaming and type conversion ONLY.
 * Does not resolve vendor_id / account_id, and makes no API calls.
 * Entity matching belongs in match-entities.ts.
 */

/** Subset of `extracted_fields` needed for Zoho Bill mapping. */
export interface ExtractedFieldsRow {
  id?: string;
  document_id?: string;
  doc_type?: string | null;
  vendor_raw: string | null;
  total_amount: number | string | null;
  invoice_date: string | Date | null;
  /** ISO 4217 code as printed on the invoice (e.g. AED, USD). */
  currency?: string | null;
  /** VAT/tax amount shown on the invoice, in invoice currency. */
  tax_amount?: number | string | null;
  /** The document's own number as printed (becomes Zoho bill_number). */
  invoice_number?: string | null;
  /** Payment due date as printed, if any. */
  due_date?: string | Date | null;
  confidence_scores?: unknown;
  raw_ocr_json?: unknown;
  ai_fallback_used?: boolean;
}

/** One extracted_line_items row as the push stage consumes it. */
export interface ExtractedLineItemRow {
  line_no?: number;
  description: string | null;
  quantity: number | string | null;
  rate: number | string | null;
  amount: number | string | null;
  account_zoho_id?: string | null;
  tax_zoho_id?: string | null;
  /** Zoho project this line is booked to. */
  project_zoho_id?: string | null;
  /** Reporting tags: [{tag_id, tag_option_id}]. */
  reporting_tags?: Array<{ tag_id: string; tag_option_id: string }> | null;
}

/** Zoho Books Bill line item (create bill). */
export interface ZohoBillLineItem {
  description: string;
  rate: number;
  quantity: number;
  /** Filled later by match-entities — never invented here. */
  account_id?: string;
  /** Per-line tax; resolved at push time. */
  tax_id?: string;
  /** Zoho project_id for this line. */
  project_id?: string;
  /** Zoho reporting tags for this line. */
  tags?: Array<{ tag_id: string; tag_option_id: string }>;
}

/**
 * Zoho Books Bill create payload fields we can populate without lookups,
 * plus raw vendor text retained for the matching stage.
 *
 * @see https://www.zoho.com/books/api/v3/bills/
 */
export interface ZohoBillMapped {
  /** Zoho `date` — yyyy-mm-dd */
  date: string;
  /** Zoho `line_items` */
  line_items: ZohoBillLineItem[];
  /**
   * Renamed from `vendor_raw`. Not a Zoho create-bill field;
   * carried for match-entities to resolve into `vendor_id`.
   */
  vendor_name: string | null;
  /** Zoho `vendor_id` — left unset until match-entities runs. */
  vendor_id?: string;
  /** Zoho `reference_number` — optional passthrough when known. */
  reference_number?: string;
  /** Invoice currency code; resolved to Zoho currency_id at push time. */
  currency?: string | null;
  /** VAT amount from the document; resolved to a Zoho tax_id at push time. */
  tax_amount?: number | null;
  /** The document's own number — Zoho `bill_number` when present. */
  invoice_number?: string | null;
  /** Zoho `due_date` — yyyy-mm-dd when present. */
  due_date?: string | null;
}

function toOptionalNumber(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number"
    ? value
    : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") {
    throw new TypeError("total_amount is required for Zoho bill mapping");
  }
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    throw new TypeError(`total_amount is not a valid number: ${String(value)}`);
  }
  return n;
}

/** Convert invoice_date → Zoho `date` (yyyy-mm-dd). */
export function toZohoDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    throw new TypeError("invoice_date is required for Zoho bill mapping");
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError("invoice_date is an invalid Date");
    }
    return value.toISOString().slice(0, 10);
  }

  const s = String(value).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`invoice_date is not a valid date: ${s}`);
  }
  return parsed.toISOString().slice(0, 10);
}

/**
 * Map one extracted_fields row into Zoho Books Bill request shape.
 *
 * Renames / conversions:
 * - invoice_date  → date (yyyy-mm-dd string)
 * - total_amount  → line_items[0].rate (number), quantity = 1
 * - vendor_raw    → vendor_name (string | null); vendor_id left for matching
 */
export function mapExtractedFieldsToZohoBill(
  row: ExtractedFieldsRow,
  lineItems?: ExtractedLineItemRow[],
): ZohoBillMapped {
  const rate = toNumber(row.total_amount);
  const date = toZohoDate(row.invoice_date);
  const vendorName =
    row.vendor_raw === null || row.vendor_raw === undefined
      ? null
      : String(row.vendor_raw).trim() || null;

  const description = vendorName
    ? `Bill from ${vendorName}`
    : "Imported bill";

  // Real extracted lines when present; else one implicit line at the gross.
  const mappedLines: ZohoBillLineItem[] = (lineItems ?? [])
    .map((li) => {
      const qty = toOptionalNumber(li.quantity) ?? 1;
      const unit = toOptionalNumber(li.rate);
      const amount = toOptionalNumber(li.amount);
      const lineRate = unit ?? (amount != null && qty > 0 ? amount / qty : amount);
      if (lineRate == null) return null;
      return {
        description: li.description?.trim() || description,
        rate: Math.round(lineRate * 100) / 100,
        quantity: qty,
        ...(li.account_zoho_id ? { account_id: li.account_zoho_id } : {}),
        ...(li.tax_zoho_id ? { tax_id: li.tax_zoho_id } : {}),
        ...(li.project_zoho_id ? { project_id: li.project_zoho_id } : {}),
        ...(Array.isArray(li.reporting_tags) && li.reporting_tags.length > 0
          ? {
            tags: li.reporting_tags
              .filter((t) => t && t.tag_id && t.tag_option_id)
              .map((t) => ({ tag_id: t.tag_id, tag_option_id: t.tag_option_id })),
          }
          : {}),
      };
    })
    .filter((li): li is ZohoBillLineItem => li !== null);

  let dueDate: string | null = null;
  try {
    dueDate = row.due_date ? toZohoDate(row.due_date) : null;
  } catch {
    dueDate = null;
  }

  return {
    date,
    vendor_name: vendorName,
    currency: row.currency?.trim().toUpperCase() || null,
    tax_amount: toOptionalNumber(row.tax_amount),
    invoice_number: row.invoice_number?.trim() || null,
    due_date: dueDate,
    line_items: mappedLines.length > 0
      ? mappedLines
      : [
        {
          description,
          rate,
          quantity: 1,
        },
      ],
  };
}
