/**
 * Items 9–12 pure-module accuracy: e-invoice readiness, corporate tax
 * provision, FX revaluation helpers.
 * Usage: node --experimental-strip-types scripts/einvoice-lock-fx-ct-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { checkEInvoiceReadiness, isValidTrn } = await import(pathToFileURL(resolve(root, "supabase/functions/zoho-approve/einvoice.ts")).href);
const { computeCtProvision, netProfitFromReport, fiscalYearStart } = await import(pathToFileURL(resolve(root, "supabase/functions/month-end/ct_provision.ts")).href);
const { validateRate, bcaParams, bcaBody, parseBcaAccounts } = await import(pathToFileURL(resolve(root, "supabase/functions/month-end/fx_reval.ts")).href);
let failures = 0;
function check(name, cond, detail = "") { const ok = Boolean(cond); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; }

console.log("— e-invoice readiness (item 9) —");
check("TRN: 15 digits valid, else not", isValidTrn("100234567890003") && !isValidTrn("12345678901234") && !isValidTrn("1002345678900031") && !isValidTrn("10023456789000A") && isValidTrn("100 2345 6789 0003"));
const EI = (over = {}) => ({ seller_trn: "100234567890003", buyer: { name: "Acme LLC", trn: "100987654321003", tax_treatment: "vat_registered" }, place_of_supply: "DU", date: "2026-08-19", currency: "AED", lines: [{ description: "Consulting", tax_id: "T1" }], ...over });
let r = checkEInvoiceReadiness(EI());
check("clean B2B invoice is ready", r.ready && r.findings.length === 0, JSON.stringify(r.findings));
r = checkEInvoiceReadiness(EI({ seller_trn: null }));
check("missing seller TRN = error", !r.ready && r.findings.some((f) => f.field === "seller_trn" && f.level === "error"));
r = checkEInvoiceReadiness(EI({ seller_trn: "12345" }));
check("malformed seller TRN = error", !r.ready && /not 15 digits/.test(r.findings[0].message));
r = checkEInvoiceReadiness(EI({ buyer: { name: "Acme LLC", trn: null, tax_treatment: "vat_registered" } }));
check("VAT-registered buyer without TRN = error, named", !r.ready && /Acme LLC/.test(r.findings[0].message), r.findings[0].message);
r = checkEInvoiceReadiness(EI({ buyer: { name: "Walk-in", trn: null, tax_treatment: "vat_not_registered" } }));
check("consumer (not registered) needs no TRN", r.ready, JSON.stringify(r.findings));
r = checkEInvoiceReadiness(EI({ buyer: { name: "Mystery", trn: null, tax_treatment: null } }));
check("no treatment on the contact = warning only", r.ready && r.findings.some((f) => f.field === "buyer_treatment" && f.level === "warning"));
r = checkEInvoiceReadiness(EI({ lines: [{ description: "Consulting", tax_id: null }, { description: "Travel", tax_id: "T1" }] }));
check("line without a tax category = warning naming it", r.ready && r.findings.some((f) => f.field === "line_tax" && /1 of 2/.test(f.message) && /Consulting/.test(f.message)));
r = checkEInvoiceReadiness(EI({ place_of_supply: "XX" }));
check("bad emirate = error", !r.ready && r.findings.some((f) => f.field === "place_of_supply"));
r = checkEInvoiceReadiness(EI({ lines: [] }));
check("no lines = error", !r.ready);

console.log("\n— corporate tax provision (item 12) —");
const SET = { rate: 9, threshold: 375000, expense_account_id: "E1", payable_account_id: "P1", expense_account_name: "Corporate Tax Expense", payable_account_name: "Corporate Tax Provision" };
let ct = computeCtProvision({ settings: SET, net_profit_ytd: 1000000, already_provided: 0, period: "2026-08", fy_start: "2026-01-01" });
check("1m profit → 9% of 625k = 56,250 proposed", ct.top_up === 56250 && ct.lines?.length === 2 && ct.lines[0].side === "D" && ct.lines[0].amount === 56250 && ct.lines[1].account_id === "P1", ct.reason);
check("notes say proxy-for-taxable-income", /proxy for taxable income/.test(ct.notes ?? ""));
ct = computeCtProvision({ settings: SET, net_profit_ytd: 1000000, already_provided: 40000, period: "2026-08", fy_start: "2026-01-01" });
check("already provided 40k → top-up 16,250", ct.top_up === 16250, ct.reason);
ct = computeCtProvision({ settings: SET, net_profit_ytd: 1000000, already_provided: 60000, period: "2026-08", fy_start: "2026-01-01" });
check("over-provided → nothing further, says so", ct.top_up === 0 && ct.lines === null && /already covered/.test(ct.reason));
ct = computeCtProvision({ settings: SET, net_profit_ytd: -791283.75, already_provided: 0, period: "2026-08", fy_start: "2026-01-01" });
check("a loss proposes nothing, says loss", ct.top_up === 0 && /loss/.test(ct.reason), ct.reason);
ct = computeCtProvision({ settings: SET, net_profit_ytd: 300000, already_provided: 0, period: "2026-08", fy_start: "2026-01-01" });
check("under the 375k threshold proposes nothing", ct.top_up === 0 && /under the 375000 threshold/.test(ct.reason), ct.reason);
ct = computeCtProvision({ settings: { ...SET, expense_account_id: null }, net_profit_ytd: 1000000, already_provided: 0, period: "2026-08", fy_start: "2026-01-01" });
check("accounts not chosen → not applicable, explains", !ct.applicable && /accounts are not chosen/.test(ct.reason));
check("net profit read from Zoho's P&L tree", netProfitFromReport([{ name: "Gross Profit", total: 3650 }, { name: "Operating Profit", total: -791283.75 }, { name: "Net Profit/Loss", total: -791283.75 }]) === -791283.75);
check("no net node → null (never guesses)", netProfitFromReport([{ name: "Gross Profit", total: 1 }]) === null);
check("fiscal year start: January default; April org in Feb → previous April", fiscalYearStart("2026-08-31", 1) === "2026-01-01" && fiscalYearStart("2026-02-10", 4) === "2025-04-01");

console.log("\n— FX revaluation helpers (item 11) —");
check("rate must be positive and sane", validateRate(3.6725).ok && !validateRate(0).ok && !validateRate(-1).ok && !validateRate("abc").ok && !validateRate(99999).ok);
const params = bcaParams("CUR1", "2026-08-31", 3.6725, "Period-end revaluation 2026-08");
check("params carry currency/date/rate/notes", params.currency_id === "CUR1" && params.adjustment_date === "2026-08-31" && params.exchange_rate === "3.6725" && params.notes.length > 0);
check("body is comma-joined account ids", JSON.stringify(bcaBody(["A", "B"])) === '{"account_ids":"A,B"}');
const exp = parseBcaAccounts("CUR1", "USD", 0, { data: { accounts: [{ account_id: "A1", account_name: "Accounts Receivable", gl_balance: 3672.5, fcy_balance: 1000, adjusted_balance: 3700, gain_or_loss: 27.5 }, { account_name: "no id dropped" }] } });
check("exposure parsed: 1 valid account, stored rate 0 → null", exp.account_count === 1 && exp.accounts[0].gain_or_loss === 27.5 && exp.stored_rate === null, JSON.stringify(exp));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
