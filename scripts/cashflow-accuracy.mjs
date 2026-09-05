/**
 * Items 13–15 pure-module accuracy: ageing, chase list, payment run,
 * payment validation, credit control.
 * Usage: node --experimental-strip-types scripts/cashflow-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { ageInvoices, buildChaseList, buildPaymentRun, validatePayment, creditCheck } =
  await import(pathToFileURL(resolve(root, "supabase/functions/cashflow/cash.ts")).href);
let failures = 0;
function check(name, cond, detail = "") { const ok = Boolean(cond); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; }

const TODAY = "2026-08-20";
const INV = (over = {}) => ({ zoho_id: "i1", number: "INV-1", party_zoho_id: "C1", party_name: "Acme Retail", date: "2026-08-01", due_date: "2026-08-15", total: 1050, balance: 1050, currency: "AED", ...over });

console.log("— ageing —");
let a = ageInvoices([
  INV({ zoho_id: "a", due_date: "2026-09-01" }),                       // current
  INV({ zoho_id: "b", due_date: "2026-08-15", balance: 500 }),         // 5 days
  INV({ zoho_id: "c", due_date: "2026-07-01", balance: 200 }),         // 50 days
  INV({ zoho_id: "d", due_date: "2026-06-01", balance: 100 }),         // 80 days
  INV({ zoho_id: "e", due_date: "2026-01-01", balance: 50 }),          // 231 days
  INV({ zoho_id: "f", balance: 0 }),                                    // settled — ignored
], TODAY);
check("buckets: current/1-30/31-60/61-90/90+", a.buckets.current.amount === 1050 && a.buckets.d1_30.amount === 500 && a.buckets.d31_60.amount === 200 && a.buckets.d61_90.amount === 100 && a.buckets.d90_plus.amount === 50, JSON.stringify(a.buckets));
check("total 1,900 over 5 invoices", a.total.amount === 1900 && a.total.count === 5);

console.log("\n— chase list —");
const HABIT = [{ party_zoho_id: "C1", pay_lag_median: 10, pay_lag_p90: 15 }];
let chase = buildChaseList([INV({ due_date: "2026-08-10" })], HABIT, TODAY);
check("overdue + past habit → chased, both said", chase.length === 1 && /10 days past due/.test(chase[0].reason) && /own habit/.test(chase[0].reason) && chase[0].can_remind, chase[0]?.reason);
chase = buildChaseList([INV({ date: "2026-08-01", due_date: "2026-09-15" })], HABIT, TODAY);
check("not due but past THEIR habit (p90=15 from Aug 1) → friendly nudge, no Zoho reminder", chase.length === 1 && /usually settles within ~15 days/.test(chase[0].reason) && chase[0].can_remind === false, chase[0]?.reason);
chase = buildChaseList([INV({ date: "2026-08-10", due_date: "2026-09-15" })], HABIT, TODAY);
check("inside habit and not due → not chased", chase.length === 0);
chase = buildChaseList([INV({ due_date: "2026-09-15" })], [], TODAY);
check("no habit known, not due → not chased (nothing to suggest)", chase.length === 0);
chase = buildChaseList([
  INV({ zoho_id: "big", due_date: "2026-08-15", balance: 10000 }),
  INV({ zoho_id: "old", due_date: "2026-05-01", balance: 100 }),
], [], TODAY);
check("ranked by money × lateness (10k×5d beats 100×111d)", chase[0].invoice.zoho_id === "big" && chase[1].invoice.zoho_id === "old", JSON.stringify(chase.map((c) => [c.invoice.zoho_id, c.score])));

console.log("\n— payment run —");
const BILL = (over = {}) => ({ zoho_id: "b1", number: "BILL-1", party_zoho_id: "V1", party_name: "Gulf Stationery", date: "2026-08-01", due_date: "2026-08-18", total: 500, balance: 500, currency: "AED", ...over });
let run = buildPaymentRun([
  BILL(),                                                              // overdue 2d
  BILL({ zoho_id: "b2", number: "BILL-2", due_date: "2026-08-25", balance: 300 }), // due in 5d
  BILL({ zoho_id: "b3", number: "BILL-3", due_date: "2026-09-15", balance: 900 }), // beyond horizon
  BILL({ zoho_id: "b4", number: "BILL-4", party_zoho_id: "V2", party_name: "Desert Logistics", due_date: null, date: "2026-08-19", balance: 200 }), // no terms → due on bill date
], { today: TODAY, horizon_days: 7, unused_credits: [{ party_zoho_id: "V1", kind: "vendorcredit", number: "VC-9", balance: 75 }] });
check("grouped per vendor; beyond-horizon bill excluded", run.length === 2 && run.find((g) => g.vendor_zoho_id === "V1").bills.length === 2 && !JSON.stringify(run).includes("BILL-3"), JSON.stringify(run.map((g) => [g.vendor_name, g.bills.map((b) => b.number)])));
const v1 = run.find((g) => g.vendor_zoho_id === "V1");
check("vendor total = sum of pay amounts (800)", v1.total === 800);
check("overdue bill first inside the group", v1.bills[0].number === "BILL-1" && v1.bills[0].days_until_due === -2);
check("unused vendor credit flagged in plain words", /75\.00 unused credit/.test(v1.note) && /before paying cash/.test(v1.note), v1.note);
check("no due date = due on the bill date", run.find((g) => g.vendor_zoho_id === "V2").bills[0].days_until_due === -1);
check("most urgent vendor group first", run[0].vendor_zoho_id === "V1");

console.log("\n— payment validation (server-side, never the client's numbers) —");
const OPEN = [BILL(), BILL({ zoho_id: "b2", number: "BILL-2", balance: 300 })];
let v = validatePayment({ vendor_id: "V1", date: "2026-08-20", bills: [{ bill_id: "b1", amount_applied: 500 }, { bill_id: "b2", amount_applied: 100 }] }, OPEN, { today: TODAY, locked_until: null });
check("full + partial application ok, total 600", v.ok && v.total === 600 && v.vendor_name === "Gulf Stationery");
v = validatePayment({ vendor_id: "V1", date: "2026-08-20", bills: [{ bill_id: "b1", amount_applied: 501 }] }, OPEN, { today: TODAY, locked_until: null });
check("overpaying a bill refused with the numbers", !v.ok && /501\.00 is more than the 500\.00/.test(v.error), v.error);
v = validatePayment({ vendor_id: "V9", date: "2026-08-20", bills: [{ bill_id: "b1", amount_applied: 100 }] }, OPEN, { today: TODAY, locked_until: null });
check("a bill belonging to another vendor refused", !v.ok && /belongs to Gulf Stationery/.test(v.error));
v = validatePayment({ vendor_id: "V1", date: "2026-07-15", bills: [{ bill_id: "b1", amount_applied: 100 }] }, OPEN, { today: TODAY, locked_until: "2026-07-31" });
check("a payment dated into a locked period refused", !v.ok && /locked through 2026-07-31/.test(v.error));
v = validatePayment({ vendor_id: "V1", date: "2026-08-20", bills: [{ bill_id: "gone", amount_applied: 100 }] }, OPEN, { today: TODAY, locked_until: null });
check("a bill no longer open → refresh the run", !v.ok && /not open any more/.test(v.error));

console.log("\n— credit control —");
let c = creditCheck({ customer_name: "Acme Retail", zoho_credit_limit: null, app_credit_limit: 5000, outstanding: 3000, unused_credits: 0, invoice_total: 1500 });
check("inside the limit: headroom said", c.applicable && !c.over && c.limit_source === "app" && /500\.00 headroom/.test(c.note), c.note);
c = creditCheck({ customer_name: "Acme Retail", zoho_credit_limit: null, app_credit_limit: 5000, outstanding: 4000, unused_credits: 800, invoice_total: 1500 });
check("over the limit: the numbers and the unused-credit hint", c.over && /4000\.00 already open \+ this 1500\.00 = 5500\.00/.test(c.note) && /800\.00 unused credit/.test(c.note), c.note);
c = creditCheck({ customer_name: "Acme Retail", zoho_credit_limit: 10000, app_credit_limit: 100, outstanding: 4000, unused_credits: 0, invoice_total: 1500 });
check("Zoho's own limit wins over the app map", !c.over && c.limit === 10000 && c.limit_source === "zoho");
c = creditCheck({ customer_name: "Acme Retail", zoho_credit_limit: null, app_credit_limit: null, outstanding: 90000, unused_credits: 0, invoice_total: 1500 });
check("no limit anywhere → not applicable, says how to set one", !c.applicable && !c.over && /Set one in Zoho Books/.test(c.note), c.note);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
