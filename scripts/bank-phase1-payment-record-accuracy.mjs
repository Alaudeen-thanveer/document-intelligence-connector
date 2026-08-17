/**
 * Bank phase 1 accuracy check: getting the payment record right.
 *   already recorded · multi-document allocation · short/partial/over ·
 *   bank charges by currency · advances · retainers · four refunds ·
 *   write-off under policy (and NOT without one).
 * Usage: node --experimental-strip-types scripts/bank-phase1-payment-record-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { suggestForLines, DEFAULT_POLICIES } = await import(pathToFileURL(resolve(root, "supabase/functions/bank-statement/suggest.ts")).href);

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const L = (line_no, txn_date, description, side, amount, reference = null) => ({ line_no, txn_date, description, reference, side, amount });
const sum = (a) => Math.round(a.reduce((s, x) => s + x.amount_applied, 0) * 100) / 100;

const parties = [
  { kind: "customer", zoho_id: "C-ACME", name: "Acme Retail Group" },
  { kind: "customer", zoho_id: "C-BLUE", name: "Blue Ocean Trading LLC" },
  { kind: "vendor", zoho_id: "V-FAL", name: "Falcon Freight LLC" },
  { kind: "vendor", zoho_id: "V-GULFC", name: "Gulf Consulting Partners" },
];
const D = (kind, zoho_id, number, party_zoho_id, party_name, date, due_date, balance) => ({ kind, zoho_id, number, party_zoho_id, party_name, date, due_date, total: balance, balance, currency: "AED" });
const openDocs = [
  D("invoice", "I-1", "INV-2001", "C-ACME", "Acme Retail Group", "2026-05-01", "2026-05-16", 1200),
  D("invoice", "I-2", "INV-2002", "C-ACME", "Acme Retail Group", "2026-06-01", "2026-06-16", 800),
  D("invoice", "I-3", "INV-2003", "C-ACME", "Acme Retail Group", "2026-07-01", "2026-07-16", 3000),
  D("invoice", "I-4", "INV-2010", "C-BLUE", "Blue Ocean Trading LLC", "2026-08-01", "2026-08-16", 3150),
  D("invoice", "I-5", "INV-2011", "C-BLUE", "Blue Ocean Trading LLC", "2026-02-01", "2026-02-16", 12.5),
  D("bill", "B-1", "FAL-2210", "V-FAL", "Falcon Freight LLC", "2026-08-09", "2026-08-24", 441),
  D("bill", "B-2", "FAL-2213", "V-FAL", "Falcon Freight LLC", "2026-08-12", "2026-08-27", 408.5),
  D("bill", "B-3", "GCP-771", "V-GULFC", "Gulf Consulting Partners", "2026-08-06", "2026-09-05", 5250),
  D("retainer", "R-1", "RET-0007", "C-BLUE", "Blue Ocean Trading LLC", "2026-08-10", null, 10000),
];
const openCredits = [
  { kind: "creditnote", zoho_id: "CN-1", number: "CN-014", party_kind: "customer", party_zoho_id: "C-ACME", party_name: "Acme Retail Group", date: "2026-07-20", balance: 350 },
  { kind: "customerpayment", zoho_id: "CP-9", number: "PMT-0099", party_kind: "customer", party_zoho_id: "C-BLUE", party_name: "Blue Ocean Trading LLC", date: "2026-07-25", balance: 500 },
  { kind: "vendorcredit", zoho_id: "VC-1", number: "VC-007", party_kind: "vendor", party_zoho_id: "V-FAL", party_name: "Falcon Freight LLC", date: "2026-07-30", balance: 120 },
  { kind: "vendorpayment", zoho_id: "VP-4", number: "VPMT-0041", party_kind: "vendor", party_zoho_id: "V-GULFC", party_name: "Gulf Consulting Partners", date: "2026-08-01", balance: 250 },
];
const recorded = [
  { kind: "vendor_payment", zoho_id: "Z-PAY-1", ref_kind: "vendorpayment", party_kind: "vendor", party_zoho_id: "V-GULFC", party_name: "Gulf Consulting Partners", amount: 5250, date: "2026-08-19", side: "debit", description: "TRF TO GULF CONSULTING PARTNERS GCP-771", source: "statement line 5 (Aug)" },
  { kind: "expense", zoho_id: "Z-EXP-2", ref_kind: "expense", party_kind: null, party_zoho_id: null, party_name: null, amount: 52.5, date: "2026-08-02", side: "debit", description: "MONTHLY ACCOUNT MAINTENANCE FEE", source: "statement line 2 (Aug)" },
];
const base = { patterns: [], parties, openDocs, openCredits, recorded, currency: "AED", today: "2026-08-17" };
const withPolicy = { ...base, policies: { ...DEFAULT_POLICIES, writeoff_after_days: 90, writeoff_max_amount: 20 } };
const noPolicy = { ...base, policies: { ...DEFAULT_POLICIES } };

// ------------------------------------------------------------- lines
const lines = [
  L(1, "2026-08-20", "TRF TO GULF CONSULTING PARTNERS GCP-771", "debit", 5250),           // already recorded (party+amount, 1 day apart)
  L(2, "2026-09-02", "MONTHLY ACCOUNT MAINTENANCE FEE", "debit", 52.5),                     // same words, but 31 days later → NOT already recorded (window 3)
  L(3, "2026-08-21", "INWARD TT ACME RETAIL GRP", "credit", 2000),                          // exact subset: 1200 + 800
  L(4, "2026-08-22", "INWARD TT ACME RETAIL GRP", "credit", 2996),                          // short by 4 on INV-2003 (3000) → bank charges (AED tol 5)
  L(5, "2026-08-23", "FASTER PAYMENT BLUE OCEAN TRADING", "credit", 2000),                  // partial on 3150 → 1150 stays open; residual too big for write-off
  L(6, "2026-08-24", "INWARD TT ACME RETAIL GRP", "credit", 6000),                          // over: nothing left open for Acme after 3,4? — see used-set behaviour below
  L(7, "2026-08-25", "BLUE OCEAN TRADING RET-0007", "credit", 10000),                       // retainer by number
  L(8, "2026-08-26", "REFUND ACME RETAIL GRP CN-014", "debit", 350),                         // credit note refund (money out)
  L(9, "2026-08-27", "REFUND TO BLUE OCEAN TRADING", "debit", 500),                          // unused customer payment refund (amount + party)
  L(10, "2026-08-28", "FALCON FREIGHT LLC VC-007", "credit", 120),                           // vendor credit refund (money in)
  L(11, "2026-08-29", "GULF CONSULTING PARTNERS", "credit", 250),                            // unused vendor payment refund
  L(12, "2026-08-30", "TRF FALCON FREIGHT LLC", "debit", 849.5),                            // exact subset of two bills 441 + 408.5
  L(13, "2026-08-31", "TRF FALCON FREIGHT LLC", "debit", 500),                              // Falcon bills used up → advance to vendor
];
const S = suggestForLines(lines, withPolicy);
const at = (n) => S[n - 1];

console.log("— already recorded (our own posts only, ±3 days) —");
check("1: same party, same amount, 1 day apart → already_recorded, link Z-PAY-1, no create", at(1)?.txn_kind === "already_recorded" && at(1).ref_zoho_id === "Z-PAY-1" && at(1).source === "already_recorded", at(1)?.reason);
check("2: same words but 31 days later → NOT already recorded (falls through; nothing learned → null)", at(2) === null || at(2).txn_kind !== "already_recorded", at(2)?.reason ?? "null");

console.log("\n— allocation across documents —");
check("3: 2,000 = INV-2001 (1,200) + INV-2002 (800) exactly → two allocations, no advance", at(3)?.txn_kind === "customer_payment" && at(3).allocations.length === 2 && sum(at(3).allocations) === 2000 && at(3).advance_amount === 0, at(3)?.reason);
check("   allocation names both invoices in order", at(3)?.allocations.map((a) => a.doc_number).join("+") === "INV-2001+INV-2002");
check("   candidates carry every open Acme invoice for re-allocation (3 at that moment)", at(3)?.candidates.length === 3, `${at(3)?.candidates.length}`);
check("4: 2,996 vs INV-2003 3,000 → short by 4 ≤ AED 5 → full settle + bank charges 4", at(4)?.allocations[0]?.amount_applied === 3000 && at(4).bank_charges === 4 && at(4).residual === 0, at(4)?.reason);
check("5: 2,000 for Blue Ocean → oldest-due first: INV-2011 (12.50) settles, then partial on INV-2010; 1,162.50 residual; no write-off (over 20)", at(5)?.allocations.map((a) => a.doc_number).join("+") === "INV-2011+INV-2010" && at(5).residual === 1162.5 && at(5).writeoff === null && at(5).bank_charges === 0, at(5)?.reason);
check("6: 6,000 from Acme with nothing left open → advance of 6,000 on account", at(6)?.txn_kind === "customer_payment" && at(6).allocations.length === 0 && at(6).advance_amount === 6000, at(6)?.reason);
check("12: 849.50 = FAL-2210 (441) + FAL-2213 (408.50) → vendor payment across two bills", at(12)?.txn_kind === "vendor_payment" && at(12).allocations.length === 2 && sum(at(12).allocations) === 849.5, at(12)?.reason);
check("13: Falcon bills already used by line 12 → 500 held as vendor advance", at(13)?.txn_kind === "vendor_payment" && at(13).allocations.length === 0 && at(13).advance_amount === 500, at(13)?.reason);

console.log("\n— retainer —");
check("7: RET-0007 named + amount → retainer_receipt with retainerinvoice ref", at(7)?.txn_kind === "retainer_receipt" && at(7).ref_kind === "retainerinvoice" && at(7).ref_zoho_id === "R-1" && at(7).confidence === 0.98, at(7)?.reason);

console.log("\n— refunds (four kinds) —");
check("8: money out to Acme naming CN-014 → creditnote_refund", at(8)?.txn_kind === "creditnote_refund" && at(8).ref_zoho_id === "CN-1", at(8)?.reason);
check("9: money out to Blue Ocean = unused payment 500 → payment_refund", at(9)?.txn_kind === "payment_refund" && at(9).ref_zoho_id === "CP-9", at(9)?.reason);
check("10: money in from Falcon naming VC-007 → vendorcredit_refund", at(10)?.txn_kind === "vendorcredit_refund" && at(10).ref_zoho_id === "VC-1", at(10)?.reason);
check("11: money in from Gulf Consulting = unused vendor payment 250 → vendorpayment_refund", at(11)?.txn_kind === "vendorpayment_refund" && at(11).ref_zoho_id === "VP-4", at(11)?.reason);

console.log("\n— over-payment stays out of documents —");
const over = suggestForLines([L(1, "2026-08-21", "FASTER PAYMENT BLUE OCEAN TRADING", "credit", 3200)], base)[0];
check("3,200 vs INV-2010 3,150 (+INV-2011 12.50 also open) → oldest-due first: 12.50 then 3,150 settle; 37.50 advance", over && over.allocations.length === 2 && sum(over.allocations) === 3162.5 && over.advance_amount === 37.5, over?.reason);

console.log("\n— write-off: only under policy, only when old enough —");
const wo1 = suggestForLines([L(1, "2026-08-21", "FASTER PAYMENT BLUE OCEAN TRADING INV2011", "credit", 2)], withPolicy)[0];
check("2.00 against INV-2011 12.50 (due Feb, 182 days) → residual 10.50 ≤ 20, old enough → write-off proposed", wo1?.residual === 10.5 && wo1.writeoff && wo1.writeoff.amount === 10.5 && wo1.writeoff.doc_number === "INV-2011", wo1?.reason);
const wo2 = suggestForLines([L(1, "2026-08-21", "FASTER PAYMENT BLUE OCEAN TRADING INV2011", "credit", 2)], noPolicy)[0];
check("same line, NO write-off policy set → residual noted, no write-off proposed", wo2?.residual === 10.5 && wo2.writeoff === null, wo2?.reason);
const wo3 = suggestForLines([L(1, "2026-08-21", "FASTER PAYMENT BLUE OCEAN TRADING INV2010", "credit", 3140)], withPolicy)[0];
check("residual 10 ≤ 20 but INV-2010 only 5 days past due → not yet; reason says so", wo3?.residual === 10 && wo3.writeoff === null && /not yet 90 days/.test(wo3.reason), wo3?.reason);

console.log("\n— bank-charge tolerance is per currency —");
const usd = suggestForLines([L(1, "2026-08-22", "INWARD TT ACME RETAIL GRP", "credit", 2988)], { ...base, currency: "USD", openDocs: [D("invoice", "I-U", "INV-U1", "C-ACME", "Acme Retail Group", "2026-07-01", "2026-07-16", 3000)] })[0];
check("USD: short by 12 ≤ USD 13 → bank charges 12", usd?.bank_charges === 12, usd?.reason);
const eur = suggestForLines([L(1, "2026-08-22", "INWARD TT ACME RETAIL GRP", "credit", 2998)], { ...base, currency: "EUR", openDocs: [D("invoice", "I-E", "INV-E1", "C-ACME", "Acme Retail Group", "2026-07-01", "2026-07-16", 3000)] })[0];
check("EUR (no tolerance set): short by 2 → partial, not bank charges", eur?.bank_charges === 0 && eur.residual === 2, eur?.reason);
const aed6 = suggestForLines([L(1, "2026-08-22", "INWARD TT ACME RETAIL GRP", "credit", 2994)], { ...base, openDocs: [D("invoice", "I-A", "INV-A1", "C-ACME", "Acme Retail Group", "2026-07-01", "2026-07-16", 3000)] })[0];
check("AED: short by 6 > 5 → partial, residual 6", aed6?.bank_charges === 0 && aed6.residual === 6, aed6?.reason);

console.log("\n— bank charges are side-aware —");
const outOver = suggestForLines([L(1, "2026-08-22", "TRF GULF CONSULTING PARTNERS GCP-771", "debit", 5253)], base)[0];
check("money OUT 5,253 for a 5,250 bill → OVER by 3 ≤ 5 → bill settles in full, 3 is bank charges (our expense)", outOver?.allocations[0]?.amount_applied === 5250 && outOver.bank_charges === 3 && outOver.advance_amount === 0, outOver?.reason);
const outShort = suggestForLines([L(1, "2026-08-22", "TRF GULF CONSULTING PARTNERS GCP-771", "debit", 5248)], base)[0];
check("money OUT 5,248 for a 5,250 bill → SHORT by 2 → partial (the vendor got less), NOT bank charges", outShort?.bank_charges === 0 && outShort.residual === 2 && outShort.allocations[0]?.amount_applied === 5248, outShort?.reason);
const inOver = suggestForLines([L(1, "2026-08-22", "INWARD TT ACME RETAIL GRP", "credit", 3003)], { ...base, openDocs: [D("invoice", "I-A", "INV-A1", "C-ACME", "Acme Retail Group", "2026-07-01", "2026-07-16", 3000)] })[0];
check("money IN 3,003 for a 3,000 invoice → OVER by 3 → 3 is an advance, NOT bank charges", inOver?.bank_charges === 0 && inOver.advance_amount === 3, inOver?.reason);

console.log("\n— nothing is decided, only proposed —");
check("every suggestion has a reason", S.filter(Boolean).every((s) => s.reason && s.reason.length > 10));
check("allocations never exceed the line amount", S.filter(Boolean).every((s) => sum(s.allocations) <= s.advance_amount + sum(s.allocations) + 0.001 && sum(s.allocations) <= lines[S.indexOf(s)].amount + s.bank_charges + 0.001));

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
