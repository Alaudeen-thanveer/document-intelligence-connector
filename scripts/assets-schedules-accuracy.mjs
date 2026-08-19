/**
 * Item 16 pure-module accuracy: bill follow-ups (asset / prepayment
 * detection), schedule arithmetic, due entries, depreciation nudge.
 * Usage: node --experimental-strip-types scripts/assets-schedules-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { detectFollowups, monthlyAmounts, schedulePeriods, dueScheduleEntries, validateSchedule, faDepreciationNudge, lastDayOf } =
  await import(pathToFileURL(resolve(root, "supabase/functions/month-end/schedules.ts")).href);
let failures = 0;
function check(name, cond, detail = "") { const ok = Boolean(cond); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; }

console.log("— follow-up detection —");
const ACCOUNTS = new Map([
  ["FA1", { name: "Furniture and Equipment", account_type: "fixed_asset" }],
  ["PP1", { name: "Prepaid Insurance", account_type: "other_current_asset" }],
  ["OCA", { name: "Employee Advance", account_type: "other_current_asset" }],
  ["EXP", { name: "Office Supplies", account_type: "expense" }],
]);
let f = detectFollowups([
  { description: "T1 office laptop", amount: 3000, account_id: "FA1" },
  { description: "T1 insurance premium 12 months", amount: 1200, account_id: "PP1" },
  { description: "staff advance", amount: 500, account_id: "OCA" },
  { description: "paper", amount: 45, account_id: "EXP" },
  { description: "no account", amount: 99, account_id: null },
], ACCOUNTS);
check("fixed-asset line proposed as an asset", f.assets.length === 1 && f.assets[0].description === "T1 office laptop" && f.assets[0].amount === 3000, JSON.stringify(f.assets));
check("prepaid-named current asset proposed as a schedule", f.prepayments.length === 1 && f.prepayments[0].account_name === "Prepaid Insurance", JSON.stringify(f.prepayments));
check("plain expenses / advances / unaccounted lines left alone", f.assets.length + f.prepayments.length === 2);

console.log("\n— schedule arithmetic —");
check("1200 over 12 = 100 each", monthlyAmounts(1200, 12).every((a) => a === 100));
const m = monthlyAmounts(1000, 12);
check("1000 over 12: 83.33 × 11 + 83.37 tail (sums exactly)", m[0] === 83.33 && m[11] === 83.37 && Math.abs(m.reduce((t, x) => t + x, 0) - 1000) < 0.001, JSON.stringify(m));
check("periods wrap the year end", JSON.stringify(schedulePeriods("2026-11", 4)) === JSON.stringify(["2026-11", "2026-12", "2027-01", "2027-02"]));
check("last day of Feb 2028 (leap)", lastDayOf("2028-02") === "2028-02-29");

console.log("\n— validation —");
check("good schedule validates", validateSchedule({ kind: "prepayment", label: "Insurance 26/27", bs_account_id: "PP1", pl_account_id: "EXP", total: 1200, months: 12, start_period: "2026-06" }).ok);
check("same account both sides refused", !validateSchedule({ kind: "prepayment", label: "x", bs_account_id: "A", pl_account_id: "A", total: 1, months: 1, start_period: "2026-06" }).ok);
check("61 months refused", /between 1 and 60/.test(validateSchedule({ kind: "accrual", label: "x", bs_account_id: "A", pl_account_id: "B", total: 1, months: 61, start_period: "2026-06" }).error));

console.log("\n— due entries —");
const S = { id: "abcdef12-3456-7890-abcd-ef1234567890", kind: "prepayment", label: "T1 insurance 12m", bs_account_id: "PP1", bs_account_name: "Prepaid Insurance", pl_account_id: "EXP", pl_account_name: "Insurance Expense", total: 1200, months: 12, start_period: "2026-06" };
let due = dueScheduleEntries(S, ["2026-06"], "2026-08", "2026-08-20");
check("June posted → July and August due", due.length === 2 && due[0].period === "2026-07" && due[1].period === "2026-08", JSON.stringify(due.map((d) => d.period)));
check("July dated month-end; August clamped to today", due[0].journal_date === "2026-07-31" && due[1].journal_date === "2026-08-20");
check("entry: Dr expense / Cr prepaid at 100", due[0].lines[0].side === "D" && due[0].lines[0].account_id === "EXP" && due[0].lines[1].side === "C" && due[0].lines[1].account_id === "PP1" && due[0].amount === 100, JSON.stringify(due[0].lines));
check("notes say month N of 12 in plain words", /month 2 of 12/.test(due[0].notes) && /releasing the prepayment/.test(due[0].notes), due[0].notes);
check("references stable and per-period", due[0].reference_number !== due[1].reference_number && due[0].reference_number.startsWith("DIC-SCH-2026-07-"));
due = dueScheduleEntries(S, [], "2026-05", "2026-05-15");
check("nothing due before the start period", due.length === 0);
due = dueScheduleEntries({ ...S, kind: "accrual", label: "T1 audit fee accrual" }, [], "2026-06", "2026-06-30");
check("accrual: same Dr-P&L / Cr-BS shape, accruing words", due[0].lines[0].side === "D" && /accruing the expense/.test(due[0].notes), due[0].notes);
due = dueScheduleEntries(S, schedulePeriods("2026-06", 12), "2027-08", "2027-08-01");
check("fully proposed schedule yields nothing", due.length === 0);

console.log("\n— depreciation nudge —");
let n = faDepreciationNudge(3, [{ journal_id: "J1", journal_date: "2026-08-31", reference_number: "DEP-AUG", notes: "Monthly depreciation" }], "2026-08");
check("assets + a depreciation journal → posted (info)", n && n.severity === "info" && /posted/.test(n.title), n?.detail);
n = faDepreciationNudge(3, [{ journal_id: "J2", journal_date: "2026-08-31", reference_number: "RENT", notes: "office rent" }], "2026-08");
check("assets + no depreciation journal → attention with the fix", n && n.severity === "attention" && /Record Depreciation/.test(n.detail), n?.detail);
check("no assets → no nudge at all", faDepreciationNudge(0, [], "2026-08") === null);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
