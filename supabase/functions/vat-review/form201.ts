/**
 * VAT return (Form 201) pre-filing review — pure.
 *
 * Recomputes what the return should say from the period's documents and
 * lists what a filer must look at before submitting in the FTA portal:
 *
 *   Outputs — box 1a–1g: standard-rated supplies per emirate (invoices −
 *   credit notes, by place_of_supply); box 4: zero-rated; box 5: exempt;
 *   out-of-scope listed separately (not on the return).
 *   Inputs  — box 9: standard-rated expenses (bills + expenses − vendor
 *   credits, recoverable input VAT); box 10: reverse-charge input
 *   (imports — also owed as output, box 3 mirror).
 *   Net     — box 12/13/14: payable or recoverable.
 *
 * Checks (each with a plain-English note):
 *   • output VAT ties to invoices: every standard-rated document's VAT is
 *     5% of its net within tolerance; documents that do not tie are named;
 *   • input VAT ties to bills likewise;
 *   • reverse charge present on imports: bills from overseas (non-GCC)
 *     vendors must carry is_reverse_charge_applied — those without are
 *     named;
 *   • designated-zone parties: documents with DZ counterparties listed for
 *     a human eye (goods vs services changes the treatment);
 *   • out-of-scope sanity: an out-of-scope or zero-rated document carrying
 *     VAT is a contradiction and is named;
 *   • place of supply present on every output;
 *   • the org's TRN is on file;
 *   • filing-date nudge: due vat_filing_due_days after period end.
 *
 * This reviews; it never files. Filing stays in the FTA portal.
 */

export interface VatDoc {
  kind: "invoice" | "creditnote" | "bill" | "vendorcredit" | "expense";
  zoho_id: string;
  number: string;
  date: string;
  status: string;
  party_name: string | null;
  /** Party VAT treatment (vat_registered / non_gcc / dz_* / …), when known. */
  tax_treatment: string | null;
  place_of_supply: string | null;
  sub_total: number;   // net of VAT
  tax_total: number;   // VAT
  total: number;
  is_reverse_charge: boolean;
  currency: string | null;
}

export interface VatCheck { name: string; passed: boolean; note: string; docs: string[] }
export interface EmirateBox { amount: number; vat: number; count: number }
export interface Form201 {
  period: { start: string; end: string };
  boxes: {
    standard_by_emirate: Record<string, EmirateBox>; // 1a–1g
    standard_total: EmirateBox;
    reverse_charge_supplies: EmirateBox;             // box 3 (mirror of imports)
    zero_rated: EmirateBox;                          // box 4
    exempt: EmirateBox;                              // box 5
    outputs_total: EmirateBox;                       // box 8
    inputs_standard: EmirateBox;                     // box 9
    inputs_reverse_charge: EmirateBox;               // box 10
    inputs_total: EmirateBox;                        // box 11
    net_vat: number;                                 // box 14: + payable / − recoverable
  };
  out_of_scope: EmirateBox; // not on the return; listed for sanity
  checks: VatCheck[];
  due_date: string;
  days_left: number;
  ready: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const EMIRATES = ["AB", "AJ", "DU", "FU", "RA", "SH", "UQ"];
const OVERSEAS = new Set(["non_gcc", "overseas", "gcc_non_vat", "gcc_vat_not_registered", "gcc_vat_registered", "non_gcc_registered"]);
const DZ = (t: string | null) => String(t ?? "").startsWith("dz_");
const box = (): EmirateBox => ({ amount: 0, vat: 0, count: 0 });
const add = (b: EmirateBox, net: number, vat: number) => { b.amount = r2(b.amount + net); b.vat = r2(b.vat + vat); b.count++; };

/** Sign: invoices/bills/expenses count +, credit notes/vendor credits −. */
function sign(d: VatDoc): number {
  return d.kind === "creditnote" || d.kind === "vendorcredit" ? -1 : 1;
}
function isOutput(d: VatDoc): boolean {
  return d.kind === "invoice" || d.kind === "creditnote";
}
/** Live documents only — drafts and voids never reach a return. */
export function countsForReturn(d: VatDoc): boolean {
  return !["draft", "void", "deleted"].includes(String(d.status).toLowerCase());
}

/** Standard / zero / exempt / out-of-scope from the document's own numbers and treatment. */
export function classify(d: VatDoc, stdRatePct: number): "standard" | "zero_rated" | "exempt" | "out_of_scope" | "reverse_charge" {
  const t = String(d.tax_treatment ?? "").toLowerCase();
  if (d.is_reverse_charge) return "reverse_charge";
  if (t === "out_of_scope" || t === "non_vat") return "out_of_scope";
  if (Math.abs(d.tax_total) > 0.005) return "standard";
  // No VAT: zero-rated vs exempt vs out of scope — exports (overseas buyer) are zero-rated.
  if (isOutput(d) && OVERSEAS.has(t)) return "zero_rated";
  if (t === "vat_exempt" || t === "exempt") return "exempt";
  return "zero_rated";
  void stdRatePct;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildForm201(
  docs: VatDoc[],
  opts: { period_start: string; period_end: string; today: string; org_trn: string | null; std_rate_pct?: number; due_days?: number; tolerance?: number },
): Form201 {
  const rate = (opts.std_rate_pct ?? 5) / 100;
  const tol = opts.tolerance ?? 0.05;
  const live = docs.filter(countsForReturn).filter((d) => d.date >= opts.period_start && d.date <= opts.period_end);

  const standardByEmirate: Record<string, EmirateBox> = {};
  const standardTotal = box(), zero = box(), exempt = box(), oos = box(), rcSupplies = box();
  const inStd = box(), inRc = box();
  // Zero-rated/exempt PURCHASES carry no recoverable VAT and are not on the
  // input boxes; tallied locally so nothing silently disappears.
  const zeroOrExemptPurchases = box();
  const missingPos: string[] = [], untiedOut: string[] = [], untiedIn: string[] = [];
  const importsNoRc: string[] = [], dzDocs: string[] = [], vatOnFree: string[] = [];

  for (const d of live) {
    const sg = sign(d);
    const net = sg * d.sub_total, vat = sg * d.tax_total;
    const cls = classify(d, opts.std_rate_pct ?? 5);
    const tag = `${d.number} (${d.party_name ?? d.kind})`;
    if (DZ(d.tax_treatment)) dzDocs.push(tag);

    if (isOutput(d)) {
      if (cls === "standard") {
        const pos = d.place_of_supply && EMIRATES.includes(d.place_of_supply) ? d.place_of_supply : null;
        if (!pos) missingPos.push(tag);
        const key = pos ?? "??";
        standardByEmirate[key] = standardByEmirate[key] ?? box();
        add(standardByEmirate[key], net, vat);
        add(standardTotal, net, vat);
        if (Math.abs(Math.abs(d.tax_total) - Math.abs(d.sub_total) * rate) > tol) untiedOut.push(`${tag}: VAT ${d.tax_total.toFixed(2)} vs ${(d.sub_total * rate).toFixed(2)} expected`);
      } else if (cls === "zero_rated") add(zero, net, 0);
      else if (cls === "exempt") add(exempt, net, 0);
      else if (cls === "out_of_scope") add(oos, net, vat);
      if (cls !== "standard" && Math.abs(d.tax_total) > 0.005) vatOnFree.push(`${tag}: ${cls.replace(/_/g, " ")} yet carries VAT ${d.tax_total.toFixed(2)}`);
    } else {
      // Purchases.
      if (cls === "reverse_charge") { add(inRc, net, vat); add(rcSupplies, net, vat); }
      else if (cls === "standard") {
        add(inStd, net, vat);
        if (Math.abs(Math.abs(d.tax_total) - Math.abs(d.sub_total) * rate) > tol) untiedIn.push(`${tag}: VAT ${d.tax_total.toFixed(2)} vs ${(d.sub_total * rate).toFixed(2)} expected`);
      } else if (cls === "out_of_scope") add(oos, net, vat);
      else add(zeroOrExemptPurchases, net, 0);
      // Imports from overseas vendors must carry the reverse charge.
      if (!d.is_reverse_charge && OVERSEAS.has(String(d.tax_treatment ?? "").toLowerCase()) && d.kind === "bill") importsNoRc.push(tag);
      if (cls !== "standard" && cls !== "reverse_charge" && Math.abs(d.tax_total) > 0.005) vatOnFree.push(`${tag}: ${cls.replace(/_/g, " ")} yet carries VAT ${d.tax_total.toFixed(2)}`);
    }
  }

  const outputsTotal = box();
  add(outputsTotal, standardTotal.amount, standardTotal.vat); outputsTotal.count = standardTotal.count;
  add(outputsTotal, rcSupplies.amount, rcSupplies.vat); outputsTotal.count += rcSupplies.count;
  add(outputsTotal, zero.amount, 0); outputsTotal.count += zero.count;
  add(outputsTotal, exempt.amount, 0); outputsTotal.count += exempt.count;
  const inputsTotal = box();
  add(inputsTotal, inStd.amount, inStd.vat); inputsTotal.count = inStd.count;
  add(inputsTotal, inRc.amount, inRc.vat); inputsTotal.count += inRc.count;
  // Reverse charge nets out (owed as output, recovered as input) — box 14 is
  // standard output VAT minus recoverable input VAT.
  const netVat = r2(standardTotal.vat + rcSupplies.vat - inputsTotal.vat);

  const dueDate = addDays(opts.period_end, opts.due_days ?? 28);
  const daysLeft = Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${opts.today}T00:00:00Z`)) / 86_400_000);

  const checks: VatCheck[] = [
    { name: "output_vat_ties", passed: untiedOut.length === 0, docs: untiedOut, note: untiedOut.length ? `${untiedOut.length} sales document(s) whose VAT is not ${opts.std_rate_pct ?? 5}% of net — recheck before filing.` : `Every standard-rated sales document's VAT is ${opts.std_rate_pct ?? 5}% of its net (±${tol.toFixed(2)}).` },
    { name: "input_vat_ties", passed: untiedIn.length === 0, docs: untiedIn, note: untiedIn.length ? `${untiedIn.length} purchase document(s) whose VAT is not ${opts.std_rate_pct ?? 5}% of net.` : "Every standard-rated purchase's VAT ties to its net." },
    { name: "reverse_charge_on_imports", passed: importsNoRc.length === 0, docs: importsNoRc, note: importsNoRc.length ? `${importsNoRc.length} bill(s) from overseas vendors WITHOUT reverse charge — box 3/10 would understate.` : "Every bill from an overseas vendor carries the reverse charge (or there are none)." },
    { name: "place_of_supply_present", passed: missingPos.length === 0, docs: missingPos, note: missingPos.length ? `${missingPos.length} sales document(s) without a valid emirate — boxes 1a–1g cannot be split correctly.` : "Every standard-rated sale names its emirate." },
    { name: "no_vat_on_free_supplies", passed: vatOnFree.length === 0, docs: vatOnFree, note: vatOnFree.length ? "Zero-rated / exempt / out-of-scope documents carrying VAT — a contradiction to resolve." : "No zero-rated, exempt or out-of-scope document carries VAT." },
    { name: "designated_zone_review", passed: true, docs: dzDocs, note: dzDocs.length ? `${dzDocs.length} document(s) with designated-zone counterparties — goods vs services changes the treatment; review by hand (listed, never blocked).` : "No designated-zone counterparties this period." },
    { name: "org_trn_on_file", passed: !!opts.org_trn, docs: [], note: opts.org_trn ? `Filing as TRN ${opts.org_trn}.` : "The organisation's TRN is not on file in Zoho — set it before filing." },
  ];

  return {
    period: { start: opts.period_start, end: opts.period_end },
    boxes: {
      standard_by_emirate: standardByEmirate,
      standard_total: standardTotal,
      reverse_charge_supplies: rcSupplies,
      zero_rated: zero,
      exempt,
      outputs_total: outputsTotal,
      inputs_standard: inStd,
      inputs_reverse_charge: inRc,
      inputs_total: inputsTotal,
      net_vat: netVat,
    },
    out_of_scope: oos,
    checks,
    due_date: dueDate,
    days_left: daysLeft,
    ready: checks.every((c) => c.passed),
  };
}


/** The VAT period containing (or last completed before) the given date. */
export function vatPeriodFor(date: string, months: number, anchorMonth: number): { start: string; end: string; label: string } {
  const [y, m] = date.split("-").map(Number);
  // Period boundaries: months that are ≡ anchorMonth (mod length).
  const len = Math.max(1, Math.min(12, months));
  let endMonth = m, endYear = y;
  while (((endMonth - anchorMonth) % len + len) % len !== 0) { endMonth++; if (endMonth > 12) { endMonth = 1; endYear++; } }
  let startMonth = endMonth - len + 1, startYear = endYear;
  if (startMonth < 1) { startMonth += 12; startYear--; }
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return {
    start: `${startYear}-${String(startMonth).padStart(2, "0")}-01`,
    end: `${endYear}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    label: len === 1 ? `${endYear}-${String(endMonth).padStart(2, "0")}` : `${startYear}-${String(startMonth).padStart(2, "0")} → ${endYear}-${String(endMonth).padStart(2, "0")}`,
  };
}
