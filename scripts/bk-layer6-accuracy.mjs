/**
 * Layer 6 accuracy check: timing / payment behaviour.
 * Synthetic docs + payments with KNOWN lags.
 * Usage: node --experimental-strip-types scripts/bk-layer6-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { buildTimingProfiles, isTimingProposable, laterThanUsual, MIN_TIMING_SAMPLE } = await import(
  pathToFileURL(resolve(root, "supabase/functions/bookkeeping-learn/timing.ts")).href
);

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

const docs = [];
const payments = [];

// Vendor A "Slow Payer Ltd": 12 bills, terms 30, entered 2 days after date,
// ALWAYS paid 45 days after date (15 late) by bank transfer from acct BANK1.
for (let i = 0; i < 12; i++) {
  const date = `2026-${String(i + 1).padStart(2, "0")}-10`;
  docs.push({ doc_kind: "bill", zoho_id: `A${i}`, party_zoho_id: "V-A", party_name: "Slow Payer Ltd",
    date, entered_date: addDays(date, 2), due_date: addDays(date, 30), terms_days: 30, total: 1000, balance: 0, status: "paid" });
  payments.push({ payment_id: `PA${i}`, party_zoho_id: "V-A", date: addDays(date, 45), amount: 1000,
    payment_mode: "banktransfer", account_id: "BANK1", account_name: "Main Bank", applied: [{ doc_zoho_id: `A${i}`, amount: 1000 }] });
}
// Vendor B "Prompt Co": 8 bills, terms 30, paid 25 days after (early), cash from PETTY.
for (let i = 0; i < 8; i++) {
  const date = `2026-0${(i % 8) + 1}-05`;
  docs.push({ doc_kind: "bill", zoho_id: `B${i}`, party_zoho_id: "V-B", party_name: "Prompt Co",
    date, entered_date: date, due_date: addDays(date, 30), terms_days: 30, total: 200, balance: 0, status: "paid" });
  payments.push({ payment_id: `PB${i}`, party_zoho_id: "V-B", date: addDays(date, 25), amount: 200,
    payment_mode: "cash", account_id: "PETTY", account_name: "Petty Cash", applied: [{ doc_zoho_id: `B${i}`, amount: 200 }] });
}
// Vendor C "Open Only": 5 bills, none paid → no lag stats, not proposable.
for (let i = 0; i < 5; i++) {
  docs.push({ doc_kind: "bill", zoho_id: `C${i}`, party_zoho_id: "V-C", party_name: "Open Only",
    date: `2026-0${i + 1}-01`, entered_date: null, due_date: null, terms_days: null, total: 50, balance: 50, status: "open" });
}
// Customer X: 6 invoices, terms 15, paid in two instalments — last payment at +40 → lag 40.
for (let i = 0; i < 6; i++) {
  const date = `2026-0${i + 1}-20`;
  docs.push({ doc_kind: "invoice", zoho_id: `X${i}`, party_zoho_id: "C-X", party_name: "Acme Retail",
    date, entered_date: addDays(date, 1), due_date: addDays(date, 15), terms_days: 15, total: 500, balance: 0, status: "paid" });
  payments.push({ payment_id: `PX${i}a`, party_zoho_id: "C-X", date: addDays(date, 10), amount: 250,
    payment_mode: "banktransfer", account_id: "BANK1", account_name: "Main Bank", applied: [{ doc_zoho_id: `X${i}`, amount: 250 }] });
  payments.push({ payment_id: `PX${i}b`, party_zoho_id: "C-X", date: addDays(date, 40), amount: 250,
    payment_mode: "banktransfer", account_id: "BANK1", account_name: "Main Bank", applied: [{ doc_zoho_id: `X${i}`, amount: 250 }] });
}
// A void bill must be ignored entirely.
docs.push({ doc_kind: "bill", zoho_id: "V0", party_zoho_id: "V-A", party_name: "Slow Payer Ltd",
  date: "2026-06-01", entered_date: "2026-06-01", due_date: null, terms_days: 30, total: 999, balance: 0, status: "void" });

const profiles = buildTimingProfiles(docs, payments);
const byId = Object.fromEntries(profiles.map((p) => [p.party_zoho_id, p]));

const A = byId["V-A"];
check("A: 12 docs (void excluded)", A?.sample_size === 12, A?.sample_size);
check("A: entry lag median 2", A?.entry_lag_median === 2);
check("A: pay lag median 45", A?.pay_lag_median === 45, A?.pay_lag_median);
check("A: terms mode 30", A?.terms_days_mode === 30);
check("A: pays 15 days later than terms", A?.pays_vs_terms_days === 15, A?.pays_vs_terms_days);
check("A: late share 1.0", A?.late_share === 1);
check("A: mode banktransfer / Main Bank", A?.payment_mode_mode === "banktransfer" && A?.payment_account_name === "Main Bank");
check("A: proposable", A && isTimingProposable(A));
check("A: confidence high", A && A.confidence > 0.75, A?.confidence);

const B = byId["V-B"];
check("B: pay lag 25, early share 1.0", B?.pay_lag_median === 25 && B?.early_share === 1);
check("B: pays 5 days EARLIER than terms (−5)", B?.pays_vs_terms_days === -5, B?.pays_vs_terms_days);
check("B: cash / Petty Cash", B?.payment_mode_mode === "cash" && B?.payment_account_name === "Petty Cash");

const C = byId["V-C"];
check("C: exists, no pay lag", C && C.pay_lag_median === null);
check("C: NOT proposable (0 paid)", C && !isTimingProposable(C), `paid=${C?.paid_sample_size} < ${MIN_TIMING_SAMPLE}`);
check("C: confidence 0", C?.confidence === 0);

const X = byId["C-X"];
check("X: customer profile", X?.party_kind === "customer");
check("X: pay lag uses FINAL payment (40, not 10)", X?.pay_lag_median === 40, X?.pay_lag_median);
check("X: pays 25 days later than 15-day terms", X?.pays_vs_terms_days === 25);
check("X: late share 1.0", X?.late_share === 1);

const lt = laterThanUsual(A, "2026-06-01", "2026-08-15");
check("laterThanUsual: 75 days open > p90 45 → later", lt.later === true && lt.days_open === 75, JSON.stringify(lt));
const lt2 = laterThanUsual(A, "2026-08-01", "2026-08-15");
check("laterThanUsual: 14 days open → not later", lt2.later === false);
const lt3 = laterThanUsual(C, "2026-01-01", "2026-08-15");
check("laterThanUsual: no p90 → never later", lt3.later === false && lt3.usual_p90 === null);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
