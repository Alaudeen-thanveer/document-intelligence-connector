/**
 * VAT return (Form 201) pre-filing review accuracy check (pure module).
 * Usage: node --experimental-strip-types scripts/vat-form201-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { buildForm201, vatPeriodFor, classify, addDays } =
  await import(pathToFileURL(resolve(root, "supabase/functions/vat-review/form201.ts")).href);
let failures = 0;
function check(name, cond, detail = "") { const ok = Boolean(cond); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; }

const D = (over = {}) => ({ kind: "invoice", zoho_id: "x", number: "INV-1", date: "2026-07-15", status: "sent", party_name: "Acme", tax_treatment: "vat_registered", place_of_supply: "DU", sub_total: 1000, tax_total: 50, total: 1050, is_reverse_charge: false, currency: "AED", ...over });
const OPTS = { period_start: "2026-07-01", period_end: "2026-09-30", today: "2026-10-05", org_trn: "100234567890003" };

console.log("— period arithmetic —");
let p = vatPeriodFor("2026-08-19", 3, 3);
check("quarter for Aug (anchor Mar) = Jul–Sep", p.start === "2026-07-01" && p.end === "2026-09-30", JSON.stringify(p));
p = vatPeriodFor("2026-01-10", 3, 3);
check("quarter for Jan spans the year end (Jan–Mar)", p.start === "2026-01-01" && p.end === "2026-03-31", JSON.stringify(p));
p = vatPeriodFor("2026-08-19", 1, 1);
check("monthly period = the month", p.start === "2026-08-01" && p.end === "2026-08-31", JSON.stringify(p));
p = vatPeriodFor("2026-05-01", 3, 1);
check("anchor Jan quarters end Jan/Apr/Jul/Oct", p.start === "2026-05-01" && p.end === "2026-07-31", JSON.stringify(p));
check("due 28 days after period end", addDays("2026-09-30", 28) === "2026-10-28");

console.log("\n— boxes —");
let f = buildForm201([
  D(), // DU 1000/50
  D({ number: "INV-2", place_of_supply: "SH", sub_total: 2000, tax_total: 100, total: 2100 }),
  D({ kind: "creditnote", number: "CN-1", sub_total: 200, tax_total: 10, total: 210 }), // reduces DU
  D({ number: "INV-3", tax_treatment: "non_gcc", sub_total: 5000, tax_total: 0, total: 5000, place_of_supply: null }), // export → zero-rated
  D({ kind: "bill", number: "BILL-1", sub_total: 800, tax_total: 40, total: 840 }),
  D({ kind: "expense", number: "EXP-1", sub_total: 100, tax_total: 5, total: 105 }),
  D({ kind: "vendorcredit", number: "VC-1", sub_total: 100, tax_total: 5, total: 105 }),
  D({ kind: "bill", number: "BILL-RC", tax_treatment: "non_gcc", sub_total: 3000, tax_total: 150, total: 3150, is_reverse_charge: true }),
  D({ number: "DRAFT", status: "draft", sub_total: 9999, tax_total: 499.95 }), // never on a return
  D({ number: "OLD", date: "2026-06-30" }), // outside period
], OPTS);
check("1a-1g: DU nets invoices − credit notes (800/40), SH 2000/100", f.boxes.standard_by_emirate.DU?.amount === 800 && f.boxes.standard_by_emirate.DU?.vat === 40 && f.boxes.standard_by_emirate.SH?.amount === 2000, JSON.stringify(f.boxes.standard_by_emirate));
check("standard total 2800/140", f.boxes.standard_total.amount === 2800 && f.boxes.standard_total.vat === 140);
check("zero-rated: the export, 5000, no VAT", f.boxes.zero_rated.amount === 5000 && f.boxes.zero_rated.vat === 0);
check("box 9 inputs: bill + expense − vendor credit = 800/40", f.boxes.inputs_standard.amount === 800 && f.boxes.inputs_standard.vat === 40, JSON.stringify(f.boxes.inputs_standard));
check("box 3/10 reverse charge: 3000/150 both sides", f.boxes.reverse_charge_supplies.vat === 150 && f.boxes.inputs_reverse_charge.vat === 150);
check("net VAT = 140 + 150 − (40 + 150) = 100 payable", f.boxes.net_vat === 100, f.boxes.net_vat);
check("drafts and out-of-period documents never counted", !JSON.stringify(f.boxes).includes("9999") && f.boxes.standard_total.count === 3);
check("due date + days left computed", f.due_date === "2026-10-28" && f.days_left === 23, `${f.due_date} · ${f.days_left}`);
check("all checks pass on clean data", f.ready, JSON.stringify(f.checks.filter((c) => !c.passed).map((c) => c.name)));

console.log("\n— checks that catch trouble —");
f = buildForm201([D({ tax_total: 43 })], OPTS); // 4.3% not 5%
check("output VAT not 5% of net → named", !f.ready && f.checks.find((c) => c.name === "output_vat_ties").passed === false && /INV-1/.test(f.checks[0].docs[0]), f.checks[0].docs[0]);
f = buildForm201([D({ kind: "bill", number: "B9", tax_total: 47 })], OPTS);
check("input VAT not 5% → named", f.checks.find((c) => c.name === "input_vat_ties").passed === false);
f = buildForm201([D({ kind: "bill", number: "IMP-1", tax_treatment: "non_gcc", tax_total: 0, is_reverse_charge: false })], OPTS);
const rc = f.checks.find((c) => c.name === "reverse_charge_on_imports");
check("overseas bill without reverse charge → flagged", rc.passed === false && /IMP-1/.test(rc.docs[0]), rc.note);
f = buildForm201([D({ place_of_supply: null })], OPTS);
check("standard sale without an emirate → flagged and parked under ??", f.checks.find((c) => c.name === "place_of_supply_present").passed === false && f.boxes.standard_by_emirate["??"]?.amount === 1000);
f = buildForm201([D({ tax_treatment: "out_of_scope", tax_total: 25 })], OPTS);
check("out-of-scope carrying VAT → contradiction named", f.checks.find((c) => c.name === "no_vat_on_free_supplies").passed === false);
f = buildForm201([D({ tax_treatment: "dz_vat_registered" })], OPTS);
const dz = f.checks.find((c) => c.name === "designated_zone_review");
check("designated-zone counterparty listed but never blocks", dz.passed === true && dz.docs.length === 1, dz.note);
f = buildForm201([D()], { ...OPTS, org_trn: null });
check("missing org TRN fails the readiness", f.checks.find((c) => c.name === "org_trn_on_file").passed === false && !f.ready);

console.log("\n— classification —");
check("reverse charge wins", classify(D({ is_reverse_charge: true }), 5) === "reverse_charge");
check("VAT present → standard", classify(D(), 5) === "standard");
check("no VAT + overseas buyer → zero-rated export", classify(D({ tax_treatment: "non_gcc", tax_total: 0 }), 5) === "zero_rated");
check("exempt treatment honoured", classify(D({ tax_treatment: "vat_exempt", tax_total: 0 }), 5) === "exempt");
check("out of scope honoured", classify(D({ tax_treatment: "out_of_scope", tax_total: 0 }), 5) === "out_of_scope");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
