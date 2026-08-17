/**
 * Bank layer 3 accuracy check: per-line suggestions — open invoice/bill
 * match, learned pattern, party name, or NOTHING.
 * Usage: node --experimental-strip-types scripts/bank-layer3-suggest-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { suggestForLines, AMOUNT_TOLERANCE } = await import(pathToFileURL(resolve(root, "supabase/functions/bank-statement/suggest.ts")).href);
const { buildBankPatterns } = await import(pathToFileURL(resolve(root, "supabase/functions/bookkeeping-learn/bank_patterns.ts")).href);

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

// ------------------------------------------------------------- context
const parties = [
  { kind: "customer", zoho_id: "C-ACME", name: "Acme Retail Group" },
  { kind: "customer", zoho_id: "C-BLUE", name: "Blue Ocean Trading LLC" },
  { kind: "vendor", zoho_id: "V-ETI", name: "Etisalat Business" },
  { kind: "vendor", zoho_id: "V-LAND", name: "Landlord Properties LLC" },
  { kind: "vendor", zoho_id: "V-GULFT", name: "Gulf Trading LLC" },
  { kind: "vendor", zoho_id: "V-GULFC", name: "Gulf Consulting Partners" },
  { kind: "vendor", zoho_id: "V-DEWA", name: "DEWA" },
];
const openDocs = [
  { kind: "invoice", zoho_id: "I-2009", number: "INV-2009", party_zoho_id: "C-ACME", party_name: "Acme Retail Group", date: "2026-07-15", due_date: "2026-07-30", total: 5000, balance: 5000, currency: "AED" },
  { kind: "invoice", zoho_id: "I-2010", number: "INV-2010", party_zoho_id: "C-BLUE", party_name: "Blue Ocean Trading LLC", date: "2026-08-01", due_date: "2026-08-16", total: 3150, balance: 3150, currency: "AED" },
  { kind: "invoice", zoho_id: "I-2011", number: "INV-2011", party_zoho_id: "C-ACME", party_name: "Acme Retail Group", date: "2026-08-10", due_date: "2026-08-25", total: 1200, balance: 1200, currency: "AED" },
  { kind: "invoice", zoho_id: "I-2012", number: "INV-2012", party_zoho_id: "C-BLUE", party_name: "Blue Ocean Trading LLC", date: "2026-08-11", due_date: "2026-08-26", total: 1200, balance: 1200, currency: "AED" },
  { kind: "bill", zoho_id: "B-771", number: "GCP-771", party_zoho_id: "V-GULFC", party_name: "Gulf Consulting Partners", date: "2026-08-06", due_date: "2026-09-05", total: 5250, balance: 5250, currency: "AED" },
  { kind: "bill", zoho_id: "B-2210", number: "FAL-2210", party_zoho_id: "V-FAL", party_name: "Falcon Freight LLC", date: "2026-08-09", due_date: "2026-08-24", total: 441, balance: 441, currency: "AED" },
];
// learned history → patterns (from bank layer 1)
const obs = [];
for (let m = 1; m <= 12; m++) obs.push({ description: `POS PURCHASE ETISALAT ${44000 + m} DUBAI AE`, side: "debit", amount: 1000 + m, date: `2026-${String(m).padStart(2, "0")}-04`, txn_kind: "expense", party_kind: "vendor", party_zoho_id: "V-ETI", party_name: "Etisalat Business", account_id: "A-TEL", account_name: "Telephone Expense", source: "zoho_bank" });
for (let m = 1; m <= 10; m++) obs.push({ description: m % 2 ? "MONTHLY ACCOUNT MAINTENANCE FEE" : "ACCOUNT MAINTENANCE CHARGES", side: "debit", amount: 52.5, date: `2026-${String(m).padStart(2, "0")}-01`, txn_kind: "expense", party_kind: null, party_zoho_id: null, party_name: null, account_id: "A-FEE", account_name: "Bank Fees and Charges", source: "zoho_bank" });
for (let m = 1; m <= 6; m++) obs.push({ description: `WPS SALARY BATCH ${1000 + m}`, side: "debit", amount: 48000, date: `2026-0${m}-28`, txn_kind: "expense", party_kind: null, party_zoho_id: null, party_name: null, account_id: m % 2 ? "A-SAL" : "A-UNC", account_name: m % 2 ? "Salaries" : "Uncategorized", source: "zoho_bank" });
const patterns = buildBankPatterns(obs);
const ctx = { patterns, parties, openDocs };

// -------------------------------------------------------------- lines
const L = (line_no, txn_date, description, side, amount, reference = null) => ({ line_no, txn_date, description, reference, side, amount });
const lines = [
  L(1, "2026-08-15", "INWARD TT ACME RETAIL GRP REF INV2009", "credit", 5000),         // invoice number + amount
  L(2, "2026-08-16", "FASTER PAYMENT BLUE OCEAN TRADING", "credit", 3150),               // amount + party name
  L(3, "2026-08-17", "INWARD REMITTANCE 7781", "credit", 1200),                          // amount only, TWO candidates → ambiguous
  L(4, "2026-08-18", "INWARD TT ACME RETAIL GRP", "credit", 1200),                       // amount + party → picks INV-2011 over INV-2012
  L(5, "2026-08-19", "TRF TO GULF CONSULTING PARTNERS GCP-771", "debit", 5250),         // bill number + amount → vendor payment applied
  L(6, "2026-08-20", "POS PURCHASE ETISALAT 044999 DUBAI AE", "debit", 1148),            // learned → Telephone Expense
  L(7, "2026-09-01", "MONTHLY ACCOUNT MAINTENANCE FEE", "debit", 52.5),                  // learned, no party
  L(8, "2026-08-28", "WPS SALARY BATCH 1007", "debit", 48000),                           // learned but split (0.43) → NOTHING
  L(9, "2026-08-22", "TRF LANDLORD PROPERTIES LLC RENT SEP", "debit", 4200),             // no open bill, nothing learned → party name only
  L(10, "2026-08-23", "OUTWARD TT GULF TRADING LLC 5512", "debit", 900),                  // "GULF" ambiguity: full name present → Gulf Trading, not Gulf Consulting
  L(11, "2026-08-24", "CHQ 000456", "debit", 2100),                                       // nothing at all
  L(12, "2026-08-25", "AMAZON WEB SERVICES EMEA", "debit", 1875),                        // unknown vendor, nothing learned → NOTHING
  L(13, "2026-08-26", "INWARD TT ACME RETAIL GRP", "credit", 999),                       // party known, but no open invoice at 999 → party_name only (customer receipt, unapplied)
  L(14, "2026-08-27", "SEA FREIGHT FAL2210 SETTLEMENT", "debit", 441.02),                // bill number in text, amount within tolerance
];
const s = suggestForLines(lines, ctx);
const at = (n) => s[n - 1];

console.log("— open documents (money in → invoices, money out → bills) —");
check("1: invoice number + amount → customer receipt applied to INV-2009 @0.98", at(1)?.source === "open_document" && at(1).doc_number === "INV-2009" && at(1).txn_kind === "customer_payment" && at(1).confidence === 0.98, at(1)?.reason);
check("2: amount + party name → applied to INV-2010 @0.9", at(2)?.doc_number === "INV-2010" && at(2).confidence === 0.9, at(2)?.reason);
check("3: amount alone with TWO open invoices at 1,200 → ambiguous → NOTHING", at(3) === null, at(3) ? JSON.stringify(at(3)) : "null");
check("4: amount + party breaks the tie → INV-2011 (Acme), not INV-2012 (Blue Ocean)", at(4)?.doc_number === "INV-2011" && at(4).party_zoho_id === "C-ACME", at(4)?.reason);
check("5: bill number + amount → vendor payment applied to GCP-771", at(5)?.txn_kind === "vendor_payment" && at(5).doc_kind === "bill" && at(5).doc_number === "GCP-771" && at(5).confidence === 0.98, at(5)?.reason);
check("14: bill number in text, amount off by 0.02 (within tolerance " + AMOUNT_TOLERANCE + ") → applied to FAL-2210", at(14)?.doc_number === "FAL-2210" && at(14).confidence === 0.98, at(14)?.reason);
check("an open document settles at most one line (INV-2011 not reused for line 13)", at(13)?.doc_zoho_id !== "I-2011");

console.log("\n— learned patterns —");
check("6: Etisalat POS → expense, Telephone Expense, vendor Etisalat, source learned @0.92", at(6)?.source === "learned" && at(6).account_id === "A-TEL" && at(6).party_zoho_id === "V-ETI" && at(6).confidence === 0.92, at(6)?.reason);
check("   reason cites the evidence", /12 earlier lines/.test(at(6)?.reason ?? ""), at(6)?.reason);
check("7: bank charge → Bank Fees, no party", at(7)?.account_id === "A-FEE" && at(7).party_kind === null && at(7).source === "learned");
check("8: salary — learned but split 50/50 (0.43 < gate) → NOTHING, line stays open", at(8) === null, at(8) ? JSON.stringify(at(8)) : "null");

console.log("\n— party name only (weak) —");
check("9: Landlord named, no open bill, nothing learned → party_name, vendor_payment, no account, low confidence", at(9)?.source === "party_name" && at(9).party_zoho_id === "V-LAND" && at(9).txn_kind === "vendor_payment" && at(9).account_id === null && at(9).confidence <= 0.6, at(9) && `conf=${at(9).confidence}`);
check("10: 'GULF TRADING LLC' → Gulf Trading, not Gulf Consulting", at(10)?.party_zoho_id === "V-GULFT", at(10)?.party_name);
check("13: Acme named, no invoice at 999 → customer receipt suggested WITHOUT an invoice (reviewer applies or leaves on account)", at(13)?.source === "party_name" && at(13).txn_kind === "customer_payment" && at(13).doc_zoho_id === null, at(13)?.reason);

console.log("\n— nothing suggestible —");
check("11: cheque number only → NOTHING", at(11) === null);
check("12: unknown vendor, nothing learned, no open bill → NOTHING", at(12) === null);
const nulls = s.filter((x) => x === null).length;
check(`exactly 4 of 14 lines left open (3, 8, 11, 12)`, nulls === 4, `${nulls} open`);

console.log("\n— nothing is ever a decision —");
check("every suggestion carries a reason and a confidence", s.filter(Boolean).every((x) => x.reason && typeof x.confidence === "number"));
check("no suggestion invents a party outside the synced list", s.filter(Boolean).every((x) => !x.party_zoho_id || parties.some((p) => p.zoho_id === x.party_zoho_id) || openDocs.some((d) => d.party_zoho_id === x.party_zoho_id)));

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
