/**
 * Purchase-order three-way match — pure.
 *
 * "Three-way" in the bookkeeper's sense: what was ORDERED (the PO in Zoho,
 * with quantities and rates), what was BILLED (the extracted bill lines),
 * and what was already RECEIVED/BILLED against the PO (Zoho's
 * quantity_billed per line). The check:
 *
 *   1. Find the PO — by the PO number read off the bill; else, when the
 *      bill names none, by the same vendor and a total within tolerance
 *      (offered as "looks like PO X", never asserted).
 *   2. Totals: bill total vs PO remaining value, within tolerance
 *      (max of a percentage and an absolute amount — both company
 *      settings).
 *   3. Lines: each bill line matched to a PO line by description words
 *      (or by rate when words are uninformative); quantity and rate
 *      compared; billing beyond the PO's remaining quantity is over-billing.
 *
 * Pass = a PO is referenced, found, and everything is within tolerance.
 * No PO referenced and none found = "not applicable" (passes; the
 * amount-above-threshold check handles the missing-PO policy).
 */

export interface PoLine {
  line_item_id: string | null;
  name: string | null;
  description: string | null;
  quantity: number;
  quantity_billed: number;
  rate: number;
  item_total: number;
}
export interface PurchaseOrder {
  zoho_id: string;
  number: string;
  /** The org may auto-number POs; the human-entered tag then lives in the reference. Both identify the PO. */
  reference?: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  date: string | null;
  status: string | null;
  total: number;
  line_items: PoLine[];
}
export interface BillLine { line_no: number; description: string | null; quantity: number | null; rate: number | null; amount: number | null }
export interface PoMatchInput {
  po_number: string | null;
  vendor_raw: string | null;
  vendor_zoho_id: string | null;
  total_amount: number | null;
  tax_amount: number | null;
  lines: BillLine[];
}
export interface PoTolerance { pct: number; amount: number }
export interface PoLineVariance {
  bill_line: number;
  po_line: string | null;
  description: string;
  qty_billed: number | null;
  qty_ordered: number | null;
  qty_remaining: number | null;
  rate_billed: number | null;
  rate_ordered: number | null;
  issue: "ok" | "qty_over_remaining" | "rate_variance" | "not_on_po";
  note: string;
}
export interface PoMatchResult {
  passed: boolean;
  applicable: boolean;
  reason: string;
  po: { zoho_id: string; number: string; vendor_name: string | null; total: number; remaining_value: number } | null;
  how_found: "po_number" | "vendor_and_total" | null;
  total_variance: number | null;
  tolerance: number | null;
  line_variances: PoLineVariance[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string | null | undefined) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const words = (s: string | null | undefined) => new Set(String(s ?? "").toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 3));

export function remainingValue(po: PurchaseOrder): number {
  return r2(po.line_items.reduce((t, l) => t + Math.max(0, l.quantity - l.quantity_billed) * l.rate, 0));
}
export function toleranceFor(value: number, tol: PoTolerance): number {
  return r2(Math.max(value * (tol.pct / 100), tol.amount));
}

export function findPurchaseOrder(input: PoMatchInput, pos: PurchaseOrder[], tol: PoTolerance): { po: PurchaseOrder; how: "po_number" | "vendor_and_total" } | null {
  const want = norm(input.po_number);
  if (want.length >= 3) {
    const keys = (p: PurchaseOrder) => [norm(p.number), norm(p.reference)].filter((k) => k.length >= 3);
    const hit = pos.find((p) => keys(p).some((k) => k === want)) ?? pos.find((p) => keys(p).some((k) => k.endsWith(want) || want.endsWith(k)));
    if (hit) return { po: hit, how: "po_number" };
    return null; // a PO number was given and does not exist — do not guess another
  }
  // No PO on the bill: same vendor + total within tolerance of the remaining value, and only if unique.
  const net = input.total_amount != null ? input.total_amount - (input.tax_amount ?? 0) : null;
  if (net == null) return null;
  const byVendor = pos.filter((p) => (input.vendor_zoho_id && p.vendor_id === input.vendor_zoho_id) || (input.vendor_raw && p.vendor_name && norm(p.vendor_name) === norm(input.vendor_raw)));
  const fits = byVendor.filter((p) => Math.abs(remainingValue(p) - net) <= toleranceFor(net, tol));
  return fits.length === 1 ? { po: fits[0], how: "vendor_and_total" } : null;
}

/** Best PO line for a bill line: most shared description words, else same rate. */
function matchLine(bl: BillLine, po: PurchaseOrder, used: Set<string>): PoLine | null {
  const bw = words(bl.description);
  let best: PoLine | null = null, bestScore = 0;
  for (const pl of po.line_items) {
    const key = pl.line_item_id ?? `${pl.name}|${pl.rate}`;
    if (used.has(key)) continue;
    const pw = new Set([...words(pl.name), ...words(pl.description)]);
    let shared = 0; for (const w of bw) if (pw.has(w)) shared++;
    const score = shared / Math.max(1, Math.min(bw.size, pw.size));
    if (score > bestScore) { bestScore = score; best = pl; }
  }
  if (best && bestScore >= 0.34) return best;
  // fall back to an identical rate when words fail
  if (bl.rate != null) {
    const byRate = po.line_items.find((pl) => !used.has(pl.line_item_id ?? `${pl.name}|${pl.rate}`) && Math.abs(pl.rate - Number(bl.rate)) <= 0.005);
    if (byRate) return byRate;
  }
  return null;
}

export function matchPurchaseOrder(input: PoMatchInput, pos: PurchaseOrder[], tol: PoTolerance): PoMatchResult {
  const found = findPurchaseOrder(input, pos, tol);
  if (!found) {
    if (norm(input.po_number).length >= 3) {
      return { passed: false, applicable: true, reason: `Bill references PO ${input.po_number} but no open purchase order with that number is in Zoho Books (synced).`, po: null, how_found: null, total_variance: null, tolerance: null, line_variances: [] };
    }
    return { passed: true, applicable: false, reason: "No purchase order referenced on the bill and none matches this vendor and amount — PO match not applicable.", po: null, how_found: null, total_variance: null, tolerance: null, line_variances: [] };
  }
  const { po, how } = found;
  const remaining = remainingValue(po);
  const net = input.total_amount != null ? r2(input.total_amount - (input.tax_amount ?? 0)) : null;
  const tolAmt = toleranceFor(remaining || po.total, tol);
  const totalVar = net != null ? r2(net - remaining) : null;

  const variances: PoLineVariance[] = [];
  const used = new Set<string>();
  for (const bl of input.lines) {
    const pl = matchLine(bl, po, used);
    if (!pl) {
      variances.push({ bill_line: bl.line_no, po_line: null, description: bl.description ?? "", qty_billed: bl.quantity, qty_ordered: null, qty_remaining: null, rate_billed: bl.rate, rate_ordered: null, issue: "not_on_po", note: `line ${bl.line_no} “${(bl.description ?? "").slice(0, 40)}” is not on the PO` });
      continue;
    }
    used.add(pl.line_item_id ?? `${pl.name}|${pl.rate}`);
    const remQty = r2(Math.max(0, pl.quantity - pl.quantity_billed));
    const qty = bl.quantity ?? 1;
    // Per-unit rate: percentage only (the absolute allowance belongs to the document total).
    const rateTol = r2(Math.max(pl.rate * (tol.pct / 100), 0.01));
    let issue: PoLineVariance["issue"] = "ok"; let note = `matches PO line “${(pl.name ?? pl.description ?? "").slice(0, 30)}”`;
    if (bl.rate != null && Math.abs(Number(bl.rate) - pl.rate) > rateTol) { issue = "rate_variance"; note = `rate ${Number(bl.rate).toFixed(2)} vs PO ${pl.rate.toFixed(2)} (tolerance ${rateTol.toFixed(2)})`; }
    else if (qty > remQty + 1e-9) { issue = "qty_over_remaining"; note = `billed ${qty} but only ${remQty} of ${pl.quantity} remain unbilled on the PO`; }
    variances.push({ bill_line: bl.line_no, po_line: pl.line_item_id, description: bl.description ?? "", qty_billed: qty, qty_ordered: pl.quantity, qty_remaining: remQty, rate_billed: bl.rate, rate_ordered: pl.rate, issue, note });
  }

  const totalOk = totalVar == null || Math.abs(totalVar) <= tolAmt;
  const badLines = variances.filter((v) => v.issue !== "ok");
  const passed = totalOk && badLines.length === 0;
  const where = how === "po_number" ? `PO ${po.number} (referenced on the bill)` : `PO ${po.number} (same vendor, amount within tolerance — not named on the bill)`;
  let reason: string;
  if (passed) reason = `Matches ${where}: net ${net?.toFixed(2)} vs remaining ${remaining.toFixed(2)}${totalVar ? ` (variance ${totalVar.toFixed(2)} within ${tolAmt.toFixed(2)})` : ""}; ${variances.length} line${variances.length === 1 ? "" : "s"} within tolerance.`;
  else {
    const parts: string[] = [];
    if (!totalOk) parts.push(`net ${net?.toFixed(2)} vs PO remaining ${remaining.toFixed(2)} — variance ${totalVar?.toFixed(2)} exceeds ${tolAmt.toFixed(2)}`);
    for (const v of badLines) parts.push(v.note);
    reason = `Does not match ${where}: ${parts.join("; ")}.`;
  }
  return { passed, applicable: true, reason, po: { zoho_id: po.zoho_id, number: po.number, vendor_name: po.vendor_name, total: po.total, remaining_value: remaining }, how_found: how, total_variance: totalVar, tolerance: tolAmt, line_variances: variances };
}
