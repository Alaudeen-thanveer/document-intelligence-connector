/**
 * Purchase-order three-way match accuracy check (pure module).
 * Usage: node --experimental-strip-types scripts/po-match-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { matchPurchaseOrder, findPurchaseOrder, remainingValue, toleranceFor } =
  await import(pathToFileURL(resolve(root, "supabase/functions/judgment/po_match.ts")).href);
let failures = 0;
function check(name, cond, detail = "") { const ok = Boolean(cond); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; }

const TOL = { pct: 2, amount: 10 };
const PO = {
  zoho_id: "po1", number: "T1-PO-0001", vendor_id: "v1", vendor_name: "T1 Gulf Stationery LLC", date: "2026-08-01", status: "open", total: 1050,
  line_items: [
    { line_item_id: "l1", name: "A4 copier paper", description: "80gsm, box of 5 reams", quantity: 20, quantity_billed: 0, rate: 45, item_total: 900 },
    { line_item_id: "l2", name: "Toner cartridge", description: "HP 26A", quantity: 1, quantity_billed: 0, rate: 150, item_total: 150 },
  ],
};
const PO2 = { ...PO, zoho_id: "po2", number: "T1-PO-0002", total: 500, line_items: [{ line_item_id: "l3", name: "Desk lamp", description: "", quantity: 5, quantity_billed: 3, rate: 100, item_total: 500 }] };
const POS = [PO, PO2];

console.log("— helpers —");
check("remaining value = unbilled qty × rate", remainingValue(PO) === 1050 && remainingValue(PO2) === 200);
check("tolerance = max(pct, amount)", toleranceFor(1050, TOL) === 21 && toleranceFor(100, TOL) === 10);

console.log("\n— finding the PO —");
const bill = (over = {}) => ({ po_number: "T1-PO-0001", vendor_raw: "T1 Gulf Stationery LLC", vendor_zoho_id: "v1", total_amount: 1102.5, tax_amount: 52.5, lines: [
  { line_no: 1, description: "A4 copier paper 80gsm", quantity: 20, rate: 45, amount: 900 },
  { line_no: 2, description: "Toner cartridge HP 26A", quantity: 1, rate: 150, amount: 150 },
], ...over });
check("found by PO number", findPurchaseOrder(bill(), POS, TOL)?.po.zoho_id === "po1" && findPurchaseOrder(bill(), POS, TOL)?.how === "po_number");
check("PO number tolerant of punctuation/case (po 0001 suffix)", findPurchaseOrder(bill({ po_number: "po-0001" }), POS, TOL)?.po.zoho_id === "po1");
check("wrong PO number → null (no guessing)", findPurchaseOrder(bill({ po_number: "T1-PO-9999" }), POS, TOL) === null);
check("no PO on bill → same vendor + amount within tolerance, unique", findPurchaseOrder(bill({ po_number: null }), POS, TOL)?.how === "vendor_and_total");
check("no PO on bill, amount fits none → null", findPurchaseOrder(bill({ po_number: null, total_amount: 700, tax_amount: 0 }), POS, TOL) === null);
check("no PO on bill, other vendor → null", findPurchaseOrder(bill({ po_number: null, vendor_zoho_id: "v9", vendor_raw: "Other" }), POS, TOL) === null);

console.log("\n— the match —");
let r = matchPurchaseOrder(bill(), POS, TOL);
check("exact bill passes", r.passed && r.applicable && r.po.number === "T1-PO-0001" && r.line_variances.every((v) => v.issue === "ok"), r.reason);
r = matchPurchaseOrder(bill({ total_amount: 1118.25, tax_amount: 53.25, lines: [{ line_no: 1, description: "A4 copier paper 80gsm", quantity: 20, rate: 45.75, amount: 915 }, { line_no: 2, description: "Toner cartridge HP 26A", quantity: 1, rate: 150, amount: 150 }] }), POS, TOL);
check("small rate/total variance within tolerance passes", r.passed && Math.abs(r.total_variance - 15) < 0.01, r.reason);
r = matchPurchaseOrder(bill({ total_amount: 1260, tax_amount: 60, lines: [{ line_no: 1, description: "A4 copier paper 80gsm", quantity: 20, rate: 52.5, amount: 1050 }, { line_no: 2, description: "Toner cartridge HP 26A", quantity: 1, rate: 150, amount: 150 }] }), POS, TOL);
check("rate variance beyond tolerance fails, named", !r.passed && r.line_variances[0].issue === "rate_variance" && /rate 52\.50 vs PO 45\.00/.test(r.reason), r.reason);
r = matchPurchaseOrder(bill({ total_amount: 1575, tax_amount: 75, lines: [{ line_no: 1, description: "A4 copier paper 80gsm", quantity: 30, rate: 45, amount: 1350 }, { line_no: 2, description: "Toner cartridge HP 26A", quantity: 1, rate: 150, amount: 150 }] }), POS, TOL);
check("over-billing quantity fails", !r.passed && r.line_variances[0].issue === "qty_over_remaining" && /billed 30 but only 20/.test(r.reason), r.reason);
r = matchPurchaseOrder(bill({ lines: [...bill().lines, { line_no: 3, description: "Delivery charge", quantity: 1, rate: 25, amount: 25 }], total_amount: 1128.75, tax_amount: 53.75 }), POS, TOL);
check("a line not on the PO is reported", !r.passed && r.line_variances[2].issue === "not_on_po" && /Delivery charge/.test(r.reason), r.reason);
r = matchPurchaseOrder(bill({ po_number: "T1-PO-0002", total_amount: 210, tax_amount: 10, lines: [{ line_no: 1, description: "Desk lamp", quantity: 2, rate: 100, amount: 200 }] }), POS, TOL);
check("partially billed PO: billing the remaining 2 of 5 passes", r.passed && r.po.remaining_value === 200, r.reason);
r = matchPurchaseOrder(bill({ po_number: "T1-PO-0002", total_amount: 315, tax_amount: 15, lines: [{ line_no: 1, description: "Desk lamp", quantity: 3, rate: 100, amount: 300 }] }), POS, TOL);
check("partially billed PO: billing 3 when 2 remain fails (qty + total)", !r.passed && /only 2 of 5 remain/.test(r.reason) && /variance 100\.00 exceeds/.test(r.reason), r.reason);
r = matchPurchaseOrder(bill({ po_number: "T1-PO-9999" }), POS, TOL);
check("PO number not in Zoho → fails with the number named", !r.passed && r.applicable && /T1-PO-9999/.test(r.reason), r.reason);
r = matchPurchaseOrder(bill({ po_number: null, vendor_zoho_id: "v9", vendor_raw: "Other Vendor", total_amount: 99, tax_amount: 0, lines: [] }), POS, TOL);
check("no PO anywhere → not applicable, passes", r.passed && !r.applicable, r.reason);
r = matchPurchaseOrder(bill({ lines: [{ line_no: 1, description: "Paper", quantity: 20, rate: 45, amount: 900 }, { line_no: 2, description: "Cartridge", quantity: 1, rate: 150, amount: 150 }] }), POS, TOL);
check("uninformative descriptions still match by identical rate", r.passed && r.line_variances.every((v) => v.issue === "ok"), r.reason);
r = matchPurchaseOrder(bill({ lines: [] }), POS, TOL);
check("no extracted lines: totals-only match still passes", r.passed && r.line_variances.length === 0, r.reason);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
