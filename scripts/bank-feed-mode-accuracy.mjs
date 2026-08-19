/**
 * Bank feed mode accuracy check: Zoho uncategorised rows → lines, Zoho
 * match candidates → "already recorded", and the exact request Zoho gets
 * for every kind of decision (match / categorize / exclude).
 * Usage: node --experimental-strip-types scripts/bank-feed-mode-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { uncategorizedToLines, suggestFromZohoMatches, buildFeedRequest, extractZohoId, refKindForZohoType, zohoTypeForRefKind } =
  await import(pathToFileURL(resolve(root, "supabase/functions/bank-statement/feed.ts")).href);
let failures = 0;
function check(name, cond, detail = "") { const ok = Boolean(cond); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; }

console.log("— uncategorised rows → lines —");
const rows = [
  { transaction_id: "U1", date: "2026-08-25", amount: "300.00", debit_or_credit: "debit", payee: "T1 Gulf Stationery LLC", description: "TRF T1 GULF STATIONERY LLC T1-BILL-0002", reference_number: "T1F001", status: "uncategorized" },
  { transaction_id: "U2", date: "2026-08-26", amount: 400, debit_or_credit: "credit", payee: "", description: "", reference_number: "T1F002", status: "uncategorized" },
  { transaction_id: "U3", date: "2026-08-27", amount: 0, debit_or_credit: "debit", description: "zero line" },
  { transaction_id: "", date: "2026-08-27", amount: 5, debit_or_credit: "debit", description: "no id" },
];
const lines = uncategorizedToLines(rows);
check("2 usable lines (zero-amount and id-less rows dropped)", lines.length === 2, JSON.stringify(lines.map((l) => [l.line_no, l.zoho_uncategorized_id, l.side, l.amount])));
check("description from Zoho description; payee kept separately", lines[0].description.startsWith("TRF T1 GULF") && lines[0].zoho_payee === "T1 Gulf Stationery LLC");
check("empty description falls back to reference", lines[1].description === "T1F002" && lines[1].side === "credit" && lines[1].amount === 400);

console.log("\n— Zoho match candidates → already recorded —");
const cands = [
  { transaction_id: "P9", transaction_type: "vendor_payment", date: "2026-08-24", amount: 300, contact_name: "T1 Gulf Stationery LLC" },
  { transaction_id: "E1", transaction_type: "expense", date: "2026-07-01", amount: 300, contact_name: null },
];
const m = suggestFromZohoMatches({ txn_date: "2026-08-25", amount: 300, side: "debit" }, cands, 3);
check("amount-equal candidate within the window → already_recorded with ref to the Zoho payment", m && m.txn_kind === "already_recorded" && m.ref_zoho_id === "P9" && m.ref_kind === "vendorpayment", m?.reason);
check("the stale July candidate is not preferred (outside window)", m && m.ref_zoho_id !== "E1");
check("no candidate fits → null", suggestFromZohoMatches({ txn_date: "2026-08-25", amount: 301, side: "debit" }, cands, 3) === null);
check("ref kind round-trips", refKindForZohoType("customer_payment") === "customerpayment" && zohoTypeForRefKind("customerpayment") === "customer_payment" && refKindForZohoType("transfer_fund") === "banktransaction");

console.log("\n— request bodies per decision —");
const base = { txn_date: "2026-08-25", description: "TRF T1 GULF", reference: "T1F001", side: "debit", amount: 300, zoho_uncategorized_id: "U1", chosen_party_kind: null, chosen_party_zoho_id: null, chosen_account_id: null, chosen_doc_kind: null, chosen_doc_zoho_id: null, chosen_allocations: null, chosen_bank_charges: null, chosen_ref_kind: null, chosen_ref_zoho_id: null };
const BANK = "BANK1";
let r = buildFeedRequest({ ...base, chosen_txn_kind: "exclude" }, BANK);
check("exclude → POST …/U1/exclude with no body", r.path === "banktransactions/uncategorized/U1/exclude" && r.body === null);
r = buildFeedRequest({ ...base, chosen_txn_kind: "already_recorded", chosen_ref_kind: "vendorpayment", chosen_ref_zoho_id: "P9", matched_transaction_type: "vendor_payment" }, BANK);
check("match → POST …/U1/match { transactions:[{transaction_id:P9, transaction_type:vendor_payment}] }", r.path.endsWith("/U1/match") && r.body.transactions[0].transaction_id === "P9" && r.body.transactions[0].transaction_type === "vendor_payment");
r = buildFeedRequest({ ...base, chosen_txn_kind: "vendor_payment", chosen_party_kind: "vendor", chosen_party_zoho_id: "V1", chosen_allocations: [{ doc_kind: "bill", doc_zoho_id: "B2", amount_applied: 300 }] }, BANK);
check("vendor payment → …/categorize/vendorpayments with bills[] and paid_through = the bank", r.path.endsWith("/categorize/vendorpayments") && r.body.vendor_id === "V1" && r.body.bills[0].bill_id === "B2" && r.body.paid_through_account_id === BANK && r.body.amount === 300);
r = buildFeedRequest({ ...base, side: "credit", amount: 2096, chosen_txn_kind: "customer_payment", chosen_party_kind: "customer", chosen_party_zoho_id: "C1", chosen_bank_charges: 4, chosen_allocations: [{ doc_kind: "invoice", doc_zoho_id: "I1", amount_applied: 2100 }] }, BANK);
check("customer receipt with bank charges → amount 2,100 (customer paid) + bank_charges 4 + invoices[]", r.path.endsWith("/categorize/customerpayments") && r.body.amount === 2100 && r.body.bank_charges === 4 && r.body.invoices[0].amount_applied === 2100 && r.body.account_id === BANK);
let threw = null; try { buildFeedRequest({ ...base, chosen_txn_kind: "vendor_payment", chosen_party_kind: "vendor", chosen_party_zoho_id: "V1", chosen_bank_charges: 3 }, BANK); } catch (e) { threw = e.message; }
check("vendor-side bank charge on a feed line is refused with guidance (one line cannot become two records)", /cannot split/.test(threw ?? ""), threw);
r = buildFeedRequest({ ...base, chosen_txn_kind: "expense", chosen_account_id: "A-FEE", chosen_party_kind: "vendor", chosen_party_zoho_id: "V2" }, BANK, "TAX5");
check("expense → …/categorize/expenses with account, vendor, tax, paid_through", r.path.endsWith("/categorize/expenses") && r.body.account_id === "A-FEE" && r.body.vendor_id === "V2" && r.body.tax_id === "TAX5" && r.body.paid_through_account_id === BANK);
r = buildFeedRequest({ ...base, chosen_txn_kind: "creditnote_refund", chosen_ref_kind: "creditnote", chosen_ref_zoho_id: "CN1" }, BANK);
check("credit-note refund (money out) → …/categorize/creditnoterefunds {creditnote_id, refund_mode, amount, date}", r.path.endsWith("/categorize/creditnoterefunds") && r.body.creditnote_id === "CN1" && r.body.refund_mode === "banktransfer" && r.body.amount === 300);
r = buildFeedRequest({ ...base, side: "credit", chosen_txn_kind: "vendorcredit_refund", chosen_ref_kind: "vendorcredit", chosen_ref_zoho_id: "VC1" }, BANK);
check("vendor-credit refund (money in) → …/categorize/vendorcreditrefunds {vendor_credit_id, account_id}", r.path.endsWith("/categorize/vendorcreditrefunds") && r.body.vendor_credit_id === "VC1" && r.body.account_id === BANK);
r = buildFeedRequest({ ...base, side: "credit", chosen_txn_kind: "deposit", chosen_account_id: "A-INC", chosen_party_kind: "customer", chosen_party_zoho_id: "C1" }, BANK);
check("deposit → generic …/categorize transaction_type=deposit, income account → bank, customer_id", r.path.endsWith("/U1/categorize") && r.body.transaction_type === "deposit" && r.body.from_account_id === "A-INC" && r.body.to_account_id === BANK && r.body.customer_id === "C1");
r = buildFeedRequest({ ...base, chosen_txn_kind: "transfer", chosen_account_id: "BANK2" }, BANK);
check("transfer (money out) → transfer_fund from bank to the other account", r.body.transaction_type === "transfer_fund" && r.body.from_account_id === BANK && r.body.to_account_id === "BANK2");
threw = null; try { buildFeedRequest({ ...base, chosen_txn_kind: "already_recorded" }, BANK); } catch (e) { threw = e.message; }
check("match without a target is refused", /needs the Zoho transaction/.test(threw ?? ""));
threw = null; try { buildFeedRequest({ ...base, chosen_txn_kind: "customer_payment", chosen_party_kind: "customer", chosen_party_zoho_id: "C1" }, BANK); } catch (e) { threw = e.message; }
check("customer receipt on a money-OUT line is refused", /money IN/.test(threw ?? ""));

console.log("\n— extracting the id Zoho answers with —");
check("payment → payment_id", extractZohoId({ code: 0, payment: { payment_id: "PP1" } }) === "PP1");
check("banktransaction → transaction_id", extractZohoId({ banktransaction: { transaction_id: "BT1" } }) === "BT1");
check("expense → expense_id", extractZohoId({ expense: { expense_id: "EX1" } }) === "EX1");
check("no object → null (caller falls back to the uncategorised id)", extractZohoId({ code: 0, message: "done" }) === null);
console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
