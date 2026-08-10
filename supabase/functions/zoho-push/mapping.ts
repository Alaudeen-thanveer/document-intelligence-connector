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
  confidence_scores?: unknown;
  raw_ocr_json?: unknown;
  ai_fallback_used?: boolean;
}

/** Zoho Books Bill line item (create bill). */
export interface ZohoBillLineItem {
  description: string;
  rate: number;
  quantity: number;
  /** Filled later by match-entities — never invented here. */
  account_id?: string;
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

  return {
    date,
    vendor_name: vendorName,
    line_items: [
      {
        description,
        rate,
        quantity: 1,
      },
    ],
  };
}
