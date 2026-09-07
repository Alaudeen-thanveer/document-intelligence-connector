/**
 * Money questions approve has to answer before it posts: which Zoho tax
 * and currency ids the document's VAT and currency map to, whether the
 * extracted lines add up to the extracted total, and the UAE emirate for
 * place of supply.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ExtractedLineItemRow } from "../zoho-push/mapping.ts";
import type { Reconciliation } from "./types.ts";
import { getZoho, withZohoRetry, zohoFetch } from "./zoho_client.ts";

// ---------------------------------------------------------------------------
// Money: VAT → tax_id, currency → currency_id (ported from zoho-push).
// VAT lives in Zoho's tax field, never inside a line amount: when the
// document's VAT matches a synced tax rate, lines are posted NET + tax_id so
// Zoho recomputes the same gross the invoice shows.
// ---------------------------------------------------------------------------
export async function resolveMoney(
  supabase: SupabaseClient,
  currencyCode: string | null | undefined,
  grossTotal: number,
  taxAmount: number | null | undefined,
): Promise<{ taxId: string | null; taxName: string | null; taxPct: number | null; currencyId: string | null; notes: string[] }> {
  const notes: string[] = [];
  let currencyId: string | null = null, taxId: string | null = null, taxName: string | null = null, taxPct: number | null = null;
  if (currencyCode) {
    const { data } = await supabase.from("zoho_entities").select("zoho_id").eq("kind", "currency").eq("name", currencyCode).maybeSingle();
    if (data?.zoho_id) currencyId = String(data.zoho_id);
    else notes.push(`currency ${currencyCode} not in synced Zoho currencies — Zoho default applies`);
  }
  if (taxAmount != null && taxAmount > 0 && grossTotal > taxAmount) {
    const net = grossTotal - taxAmount;
    const pct = (taxAmount / net) * 100;
    const { data: taxes } = await supabase.from("zoho_entities").select("zoho_id, name, extra").eq("kind", "tax");
    const match = (taxes ?? []).find((t) => {
      const p = Number((t.extra as { percentage?: unknown })?.percentage);
      return Number.isFinite(p) && p > 0 && Math.abs(p - pct) <= 0.5;
    });
    if (match) { taxId = String(match.zoho_id); taxName = String(match.name); taxPct = Number((match.extra as { percentage?: unknown }).percentage); }
    else notes.push(`VAT ${taxAmount} on ${grossTotal} (~${pct.toFixed(1)}%) matches no synced Zoho tax rate — posted without tax_id`);
  }
  return { taxId, taxName, taxPct, currencyId, notes };
}

/**
 * Do the extracted lines add up to the extracted total? Tolerance is 0.05
 * plus 0.1% of the total (OCR rounding). Lines with no usable rate are
 * reported as dropped — they never disappear silently.
 */
export function reconcile(
  mapped: { line_items: Array<{ rate: number; quantity: number }> },
  lineRows: ExtractedLineItemRow[],
  documentTotal: number,
  taxAmount: number | null,
): Reconciliation {
  const tax = taxAmount != null && taxAmount > 0 ? taxAmount : 0;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const hasRealLines = lineRows.length > 0;
  const dropped = lineRows
    .filter((li) => { const rate = li.rate == null || li.rate === "" ? null : Number(li.rate); const amt = li.amount == null || li.amount === "" ? null : Number(li.amount); return (rate == null || !Number.isFinite(rate)) && (amt == null || !Number.isFinite(amt)); })
    .map((li) => Number(li.line_no));
  if (!hasRealLines || dropped.length === lineRows.length) {
    // No lines, or none readable at all: the header total is the only
    // reliable money. One line at the total (the old behaviour), flagged.
    return { ok: true, mode: "implicit", lines_total: round2(documentTotal), tax_amount: tax, document_total: round2(documentTotal), dropped_lines: dropped,
      message: hasRealLines ? `no extracted line had a readable amount — one line at the document total` : "no extracted lines — one line at the document total" };
  }
  const linesTotal = round2(mapped.line_items.reduce((t, li) => t + li.rate * li.quantity, 0));
  const tol = 0.05 + documentTotal * 0.001;
  const asNet = Math.abs(linesTotal + tax - documentTotal);
  const asGross = Math.abs(linesTotal - documentTotal);
  if (dropped.length === 0 && asNet <= tol) return { ok: true, mode: "net", lines_total: linesTotal, tax_amount: tax, document_total: round2(documentTotal), dropped_lines: [], message: `lines ${linesTotal.toFixed(2)} + VAT ${tax.toFixed(2)} = total ${documentTotal.toFixed(2)}` };
  if (dropped.length === 0 && tax > 0 && asGross <= tol) return { ok: true, mode: "gross", lines_total: linesTotal, tax_amount: tax, document_total: round2(documentTotal), dropped_lines: [], message: `lines ${linesTotal.toFixed(2)} already include VAT ${tax.toFixed(2)} (= total)` };
  if (dropped.length === 0 && tax === 0 && asGross <= tol) return { ok: true, mode: "net", lines_total: linesTotal, tax_amount: 0, document_total: round2(documentTotal), dropped_lines: [], message: `lines ${linesTotal.toFixed(2)} = total ${documentTotal.toFixed(2)}` };
  const why = dropped.length
    ? `line${dropped.length > 1 ? "s" : ""} ${dropped.join(", ")} ha${dropped.length > 1 ? "ve" : "s"} no amount (OCR could not read quantity × rate) — fix the line${dropped.length > 1 ? "s" : ""} in review`
    : `lines ${linesTotal.toFixed(2)}${tax ? ` + VAT ${tax.toFixed(2)} = ${(linesTotal + tax).toFixed(2)}` : ""} do not match the document total ${documentTotal.toFixed(2)} — correct the lines or the total in review`;
  return { ok: false, mode: "mismatch", lines_total: linesTotal, tax_amount: tax, document_total: round2(documentTotal), dropped_lines: dropped, message: why };
}

/** UAE emirate → Zoho place_of_supply code. */
const EMIRATE_CODES: Record<string, string> = {
  "abu dhabi": "AB", ajman: "AJ", dubai: "DU", fujairah: "FU", "ras al khaimah": "RA", "ras al-khaimah": "RA", sharjah: "SH", "umm al quwain": "UQ", "umm al-quwain": "UQ",
};
export function emirateCode(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^[A-Z]{2}$/.test(s)) return s;
  return EMIRATE_CODES[s.toLowerCase()] ?? null;
}

/**
 * Emirate code for place_of_supply (UAE VAT requires it on sales invoices).
 * Contacts in the UAE edition carry no place-of-contact field, so: explicit
 * input → the customer's billing state code → company default → the Zoho
 * organisation's own emirate.
 */
export async function resolvePlaceOfSupply(
  supabase: SupabaseClient,
  explicit: string | null | undefined,
  customerId: string,
  companyId: string,
): Promise<string | null> {
  if (explicit?.trim()) return emirateCode(explicit) ?? explicit.trim();
  const contact = await withZohoRetry(companyId, async (z) => {
    const res = await zohoFetch(`${z.apiBase}/contacts/${encodeURIComponent(customerId)}?organization_id=${encodeURIComponent(z.organizationId)}`, { headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` } });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, raw };
  });
  const c = (contact.raw as { contact?: { place_of_contact?: string; billing_address?: { state_code?: string; state?: string } } })?.contact;
  const fromContact = emirateCode(c?.place_of_contact) ?? emirateCode(c?.billing_address?.state_code) ?? emirateCode(c?.billing_address?.state);
  if (fromContact) return fromContact;
  const { data: cfg } = await supabase.from("company_config").select("default_place_of_supply").eq("company_id", companyId).maybeSingle();
  const fromCompany = emirateCode(cfg?.default_place_of_supply);
  if (fromCompany) return fromCompany;
  // Needed after the call returns as well, to pick this company's org out of
  // the list, so resolve it here rather than reaching into the callback.
  const zOrg = (await getZoho(companyId)).organizationId;
  const org = await withZohoRetry(companyId, async (z) => {
    const res = await zohoFetch(`${z.apiBase}/organizations?organization_id=${encodeURIComponent(z.organizationId)}`, { headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` } });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, raw };
  });
  const o = ((org.raw as { organizations?: Array<Record<string, unknown>> })?.organizations ?? []).find((x) => String(x.organization_id) === zOrg) ?? ((org.raw as { organizations?: Array<Record<string, unknown>> })?.organizations ?? [])[0];
  return emirateCode(o?.state) ?? emirateCode((o?.address as { state?: string } | undefined)?.state) ?? null;
}
