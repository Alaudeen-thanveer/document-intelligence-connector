/**
 * Books hygiene + statement evidence accuracy (pure modules).
 * Usage: node --experimental-strip-types scripts/hygiene-evidence-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { normContactName, findSuspenseBalances, findDuplicateContacts, findMissingTrns, findDuplicateAccounts, unusedAccountCandidates } =
  await import(pathToFileURL(resolve(root, "supabase/functions/month-end/hygiene.ts")).href);
const { attachTargetFor, buildLineEvidence } = await import(pathToFileURL(resolve(root, "supabase/functions/bank-statement/evidence.ts")).href);
let failures = 0;
function check(name, cond, detail = "") { const ok = Boolean(cond); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; }

console.log("— name normalisation —");
check("legal suffixes stripped, punctuation-blind", normContactName("Gulf Stationery L.L.C.") === "GULF STATIONERY" && normContactName("Gulf Stationery LLC") === "GULF STATIONERY" && normContactName("Desert Logistics FZE") === "DESERT LOGISTICS");
check("stacked suffixes stripped (General Trading LLC)", normContactName("Oasis General Trading LLC") === "OASIS");
check("a bare suffix-looking name survives", normContactName("LLC") === "LLC" && normContactName("Trading") === "TRADING");

console.log("\n— suspense balances —");
const ACC = (over = {}) => ({ account_id: "A1", account_name: "Suspense", account_type: "other_current_asset", current_balance: 500, is_active: true, is_user_created: true, is_system_account: false, ...over });
let s = findSuspenseBalances([
  ACC(),
  ACC({ account_id: "A2", account_name: "Uncategorized Income", current_balance: -75 }),
  ACC({ account_id: "A3", account_name: "Opening Balance Adjustments", current_balance: 1200 }),
  ACC({ account_id: "A4", account_name: "Suspense", current_balance: 0 }),          // cleared — quiet
  ACC({ account_id: "A5", account_name: "Office Supplies", current_balance: 900 }), // normal account — quiet
  ACC({ account_id: "A6", account_name: "Suspense Old", current_balance: 10, is_active: false }), // inactive — quiet
]);
check("suspense + uncategorised + opening-balance flagged; cleared/normal/inactive quiet", s.length === 3 && s[0].account_name === "Opening Balance Adjustments", JSON.stringify(s.map((x) => [x.account_name, x.balance])));
check("largest parked amount first, note says what to do", s[0].balance === 1200 && /move it to its real account|clearing with the accountant/.test(s[1].note), s[1].note);

console.log("\n— duplicate contacts —");
const C = (over = {}) => ({ zoho_id: "c1", name: "Gulf Stationery LLC", kind: "vendor", trn: null, tax_treatment: "vat_registered", status: "active", ...over });
let d = findDuplicateContacts([
  C(),
  C({ zoho_id: "c2", name: "Gulf Stationery L.L.C." }),
  C({ zoho_id: "c3", name: "Desert Logistics FZE" }),
  C({ zoho_id: "c4", name: "Gulf Stationery LLC", status: "inactive" }), // inactive ignored
]);
check("same vendor twice under suffix variants → one group, merge advice", d.length === 1 && d[0].reason === "name" && d[0].ids.length === 2 && /Merge/.test(d[0].note), JSON.stringify(d));
d = findDuplicateContacts([
  C({ zoho_id: "c1", name: "Alpha Trading", trn: "100000000000001" }),
  C({ zoho_id: "c2", name: "Beta Spares", trn: "100000000000001" }),
]);
check("two names sharing one TRN → flagged by TRN", d.length === 1 && d[0].reason === "trn" && /share TRN/.test(d[0].note), d[0]?.note);
check("customers and vendors never cross-grouped", findDuplicateContacts([C(), C({ zoho_id: "c9", kind: "customer" })]).length === 0);

console.log("\n— missing TRNs —");
let m = findMissingTrns([
  C({ zoho_id: "c1", trn: null }),                                        // registered, none → flagged
  C({ zoho_id: "c2", trn: "12345" }),                                     // malformed → flagged
  C({ zoho_id: "c3", trn: "100234567890003" }),                           // fine
  C({ zoho_id: "c4", tax_treatment: "non_gcc", trn: null }),              // overseas — no TRN expected
  C({ zoho_id: "c5", trn: null, status: "inactive" }),                    // inactive — quiet
]);
check("registered-without-valid-TRN flagged; overseas/inactive quiet", m.length === 2 && m.some((x) => /no TRN/.test(x.note)) && m.some((x) => /not 15 digits/.test(x.note)), JSON.stringify(m.map((x) => x.zoho_id)));

console.log("\n— accounts —");
let da = findDuplicateAccounts([
  ACC({ account_id: "A1", account_name: "Office Supplies" }),
  ACC({ account_id: "A2", account_name: "Office  Supplies." }),
  ACC({ account_id: "A3", account_name: "Office Equipment" }),
]);
check("same ledger account twice (spacing/punctuation) → flagged", da.length === 1 && da[0].ids.length === 2 && /keep one and deactivate/.test(da[0].note), JSON.stringify(da));
const cands = unusedAccountCandidates([
  ACC({ account_id: "A1", current_balance: 0 }),
  ACC({ account_id: "A2", current_balance: 100 }),                         // has balance
  ACC({ account_id: "A3", current_balance: 0, is_user_created: false }),   // system default
  ACC({ account_id: "A4", current_balance: 0, is_active: false }),         // already deactivated
]);
check("unused candidates: zero-balance user-created active only", cands.length === 1 && cands[0].account_id === "A1");

console.log("\n— statement evidence —");
check("attachment slots per kind", attachTargetFor("customer_payment", "Z1").path === "customerpayments/Z1/attachment" && attachTargetFor("retainer_receipt", "Z1").path === "customerpayments/Z1/attachment" && attachTargetFor("vendor_payment", "Z1").path === "vendorpayments/Z1/attachment" && attachTargetFor("expense", "Z1").path === "expenses/Z1/receipt" && attachTargetFor("expense", "Z1").field === "receipt" && attachTargetFor("deposit", "Z1").path === "banktransactions/Z1/attachment");
check("refund kinds carry their own document links — no slot", attachTargetFor("creditnote_refund", "Z1") === null && attachTargetFor("already_recorded", "Z1") === null);
const ev = buildLineEvidence(
  { line_no: 3, txn_date: "2026-08-21", description: "T1 BANK CHARGES AUG", reference: null, side: "debit", amount: 25 },
  { bank_account_name: "T1 Test Bank", bank_account_zoho_id: "B1", period_start: "2026-08-19", period_end: "2026-08-23", source: "paste", original_name: null, currency: "AED" },
  "reviewer@local.test",
);
check("text note: bank, period, line, direction, who confirmed", /T1 Test Bank/.test(ev.text) && /2026-08-19 to 2026-08-23/.test(ev.text) && /Money out : 25\.00 AED/.test(ev.text) && /pasted as text/.test(ev.text) && /reviewer@local\.test/.test(ev.text), ev.text.split("\n").slice(5, 10).join(" | "));
check("filename dated, per-line, and a PDF (Zoho refuses .txt)", ev.filename === "statement-line-2026-08-21-3.pdf");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
