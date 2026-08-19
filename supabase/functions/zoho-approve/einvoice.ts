/**
 * UAE e-invoicing field readiness — pure.
 *
 * The UAE mandate (PINT AE over Peppol, 5-corner): pilot/voluntary from
 * 1 July 2026; mandatory for businesses with revenue ≥ AED 50m from
 * 1 January 2027, all other businesses 1 July 2027, government entities
 * 1 October 2027. Invoices are ISSUED only through a Ministry-accredited
 * service provider — never by this tool, and not by this check. What we
 * do: before a sales invoice is created in Zoho Books, verify the fields
 * the e-invoice will need, so nothing bounces at the ASP later.
 *
 * Checked:
 *   • seller TRN present and well-formed (15 digits);
 *   • buyer TRN on B2B: a VAT-registered buyer must have a well-formed TRN;
 *   • tax category per line: every line carries a tax (standard/zero/exempt
 *     id), or the document is explicitly out of scope;
 *   • place of supply present (emirate code);
 *   • invoice date and currency present.
 *
 * Findings are errors (the e-invoice WILL bounce) or warnings (likely to
 * need attention). They inform the reviewer; the invoice is still created
 * in Zoho Books — issuance and transmission stay with Zoho and the ASP.
 */

export interface EInvoiceLine { description: string | null; tax_id: string | null }
export interface EInvoiceInput {
  seller_trn: string | null;
  buyer: { name: string | null; trn: string | null; tax_treatment: string | null };
  place_of_supply: string | null;
  date: string | null;
  currency: string | null;
  lines: EInvoiceLine[];
}
export interface EInvoiceFinding { level: "error" | "warning"; field: string; message: string }

const EMIRATES = new Set(["AB", "AJ", "DU", "FU", "RA", "SH", "UQ"]);

/** UAE TRN: exactly 15 digits. */
export function isValidTrn(trn: string | null | undefined): boolean {
  return /^\d{15}$/.test(String(trn ?? "").replace(/\s/g, ""));
}

export function checkEInvoiceReadiness(input: EInvoiceInput): { findings: EInvoiceFinding[]; ready: boolean } {
  const f: EInvoiceFinding[] = [];
  // Seller.
  if (!input.seller_trn) f.push({ level: "error", field: "seller_trn", message: "The organisation's TRN is not set in Zoho Books — an e-invoice cannot be issued without it." });
  else if (!isValidTrn(input.seller_trn)) f.push({ level: "error", field: "seller_trn", message: `The organisation's TRN "${input.seller_trn}" is not 15 digits — fix it in Zoho Books settings.` });
  // Buyer (B2B = the buyer is VAT-registered; consumers need no TRN).
  const treatment = String(input.buyer.tax_treatment ?? "").toLowerCase();
  const b2b = treatment === "vat_registered" || treatment === "dz_vat_registered" || treatment === "gcc_vat_registered";
  if (b2b) {
    if (!input.buyer.trn) f.push({ level: "error", field: "buyer_trn", message: `${input.buyer.name ?? "The buyer"} is VAT-registered but has no TRN on the contact — the e-invoice needs it.` });
    else if (!isValidTrn(input.buyer.trn)) f.push({ level: "error", field: "buyer_trn", message: `${input.buyer.name ?? "The buyer"}'s TRN "${input.buyer.trn}" is not 15 digits.` });
  } else if (!treatment) {
    f.push({ level: "warning", field: "buyer_treatment", message: `${input.buyer.name ?? "The buyer"} has no VAT treatment on the contact — set it so B2B vs B2C is unambiguous.` });
  }
  // Tax category per line.
  const untaxed = input.lines.filter((l) => !l.tax_id);
  if (input.lines.length === 0) f.push({ level: "error", field: "lines", message: "No line items." });
  else if (untaxed.length) f.push({ level: "warning", field: "line_tax", message: `${untaxed.length} of ${input.lines.length} line(s) carry no tax category (standard / zero-rated / exempt) — the e-invoice needs one per line: ${untaxed.map((l) => (l.description ?? "?").slice(0, 30)).join("; ")}` });
  // Place of supply, date, currency.
  if (!input.place_of_supply || !EMIRATES.has(input.place_of_supply)) f.push({ level: "error", field: "place_of_supply", message: `Place of supply "${input.place_of_supply ?? ""}" is not a valid emirate code.` });
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) f.push({ level: "error", field: "date", message: "Invoice date missing or malformed." });
  if (!input.currency) f.push({ level: "warning", field: "currency", message: "Currency not stated — AED will be assumed." });

  return { findings: f, ready: !f.some((x) => x.level === "error") };
}
