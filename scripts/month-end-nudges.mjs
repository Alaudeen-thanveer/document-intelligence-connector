/**
 * Unit checks for month-end nudges (pure).
 * Usage: node --experimental-strip-types scripts/month-end-nudges.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { recurringDueInMonth, recurringJournalNudges, expectedBillNudges, journalPatternNudges, laterThanUsualNudges } = await import(
  pathToFileURL(resolve(root, "supabase/functions/month-end/nudges.ts")).href
);

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

const monthly = { recurring_journal_id: "RJ1", recurrence_name: "Monthly depreciation", recurrence_frequency: "months", repeat_every: 1, start_date: "2026-01-31", end_date: "2027-12-31", status: "active", total: 1250 };
const quarterly = { ...monthly, recurring_journal_id: "RJ2", recurrence_name: "Quarterly accrual", repeat_every: 3 };
const stopped = { ...monthly, recurring_journal_id: "RJ3", recurrence_name: "Old", status: "stopped" };
const future = { ...monthly, recurring_journal_id: "RJ4", recurrence_name: "Future", start_date: "2027-01-01" };

check("monthly due in Aug 2026", recurringDueInMonth(monthly, "2026-08"));
check("quarterly due Jan/Apr/Jul/Oct, not Aug", recurringDueInMonth(quarterly, "2026-07") && !recurringDueInMonth(quarterly, "2026-08"));
check("stopped never due", !recurringDueInMonth(stopped, "2026-08"));
check("future start not due yet", !recurringDueInMonth(future, "2026-08"));
check("not due after end_date", !recurringDueInMonth(monthly, "2028-01"));

// Zoho list-view shape: no start_date, but next/last journal dates.
const zohoList = { recurring_journal_id: "RJ9", recurrence_name: "Monthly depreciation", recurrence_frequency: "months", repeat_every: 1, start_date: "", end_date: null, status: "active", total: 1250, next_journal_date: "2026-08-31", last_journal_date: "" };
check("list-view def: due in month of next_journal_date", recurringDueInMonth(zohoList, "2026-08"));
check("list-view def: not due in an earlier month", !recurringDueInMonth(zohoList, "2026-07"));
check("list-view def: not due in a later month (next is Aug)", !recurringDueInMonth(zohoList, "2026-09"));
const zohoPosted = { ...zohoList, last_journal_date: "2026-08-31", next_journal_date: "2026-09-30" };
let zn = recurringJournalNudges([zohoPosted], [], "2026-08");
check("list-view def: last_journal_date in month → posted (no journal match needed)", zn[0]?.kind === "recurring_journal_posted", zn[0]?.title);
zn = recurringJournalNudges([zohoList], [], "2026-08");
check("list-view def: not yet run → due", zn[0]?.kind === "recurring_journal_due");

const posted = [
  { journal_id: "J1", journal_date: "2026-08-31", reference_number: null, notes: "Monthly depreciation Aug", total: 1250 },
];
let n = recurringJournalNudges([monthly, quarterly, stopped], posted, "2026-08");
check("Aug: depreciation posted → info", n.find((x) => x.ref.recurring_journal_id === "RJ1")?.kind === "recurring_journal_posted");
check("Aug: quarterly not due → absent", !n.some((x) => x.ref.recurring_journal_id === "RJ2"));
check("Aug: stopped absent", !n.some((x) => x.ref.recurring_journal_id === "RJ3"));
n = recurringJournalNudges([monthly], [], "2026-09");
check("Sep: depreciation not posted → attention", n[0]?.kind === "recurring_journal_due" && n[0].severity === "attention", n[0]?.title);
check("nudge key is stable per def+month", n[0]?.key === "rj:RJ1:2026-09");

const enabled = [
  { party_zoho_id: "V1", party_name: "DEWA", next_expected: "2026-08-01", day_min: 1, day_max: 5 },
  { party_zoho_id: "V2", party_name: "Landlord", next_expected: "2026-08-01", day_min: 1, day_max: 3 },
];
const seen = [{ vendor_zoho_id: "V1", vendor_name: "DEWA", invoice_date: "2026-08-03" }];
n = expectedBillNudges(enabled, seen, "2026-08", "2026-08-20");
check("DEWA arrived → info", n.find((x) => x.ref.party_zoho_id === "V1")?.kind === "expected_bill_arrived");
check("Landlord missing after window → attention", n.find((x) => x.ref.party_zoho_id === "V2")?.kind === "expected_bill_missing");
n = expectedBillNudges(enabled, [], "2026-08", "2026-08-02");
check("day 2, within Landlord window (≤3) → no nudge yet", !n.some((x) => x.ref.party_zoho_id === "V2"));
check("day 2, within DEWA window (≤5) → no nudge yet", !n.some((x) => x.ref.party_zoho_id === "V1"));
n = expectedBillNudges(enabled, [], "2026-07", "2026-08-02");
check("past month, nothing seen → both missing", n.filter((x) => x.kind === "expected_bill_missing").length === 2);
n = expectedBillNudges(enabled, [{ vendor_zoho_id: null, vendor_name: "dewa", invoice_date: "2026-08-04" }], "2026-08", "2026-08-20");
check("arrival matched by name when id missing", n.find((x) => x.ref.party_zoho_id === "V1")?.kind === "expected_bill_arrived");

// --- layer 5: enabled journal patterns (by fingerprint) ---
const jpEnabled = [{ fingerprint: "A:D+B:C", label: "Dr Accrued / Cr Payable", cadence: "fixed_recurring", amount_median: 800, expected_day_min: 28, expected_day_max: 31 }];
const jpPosted = [{ journal_id: "J9", journal_date: "2026-08-31", reference_number: null, notes: null, total: 800, fingerprint: "A:D+B:C" }];
n = journalPatternNudges(jpEnabled, jpPosted, "2026-08");
check("jp: posted this month → info", n[0]?.kind === "recurring_journal_posted", n[0]?.title);
n = journalPatternNudges(jpEnabled, jpPosted, "2026-09");
check("jp: not posted → due (attention), names learned pattern", n[0]?.kind === "recurring_journal_due" && /learned pattern/.test(n[0].detail));
n = journalPatternNudges(jpEnabled, [{ ...jpPosted[0], fingerprint: "X:D+Y:C" }], "2026-08");
check("jp: different fingerprint does not count", n[0]?.kind === "recurring_journal_due");
check("jp: key stable per fingerprint+month", n[0]?.key === "jp:A:D+B:C:2026-08");

// --- layer 6: enabled later-than-usual ---
const ltuEnabled = [{ party_kind: "vendor", party_zoho_id: "V1", party_name: "Slow Payer", pay_lag_p90: 45, pay_lag_median: 40 }];
const open = [
  { doc_kind: "bill", zoho_id: "B1", number: "INV-1", party_zoho_id: "V1", date: "2026-06-01", balance: 100 },
  { doc_kind: "bill", zoho_id: "B2", number: "INV-2", party_zoho_id: "V1", date: "2026-08-01", balance: 100 },
  { doc_kind: "bill", zoho_id: "B3", number: "INV-3", party_zoho_id: "V1", date: "2026-05-01", balance: 0 },
  { doc_kind: "invoice", zoho_id: "I1", number: "SI-1", party_zoho_id: "V1", date: "2026-05-01", balance: 50 },
  { doc_kind: "bill", zoho_id: "B4", number: "INV-4", party_zoho_id: "V2", date: "2026-05-01", balance: 50 },
];
n = laterThanUsualNudges(ltuEnabled, open, "2026-08-15");
check("ltu: exactly one nudge (75-day open bill)", n.length === 1 && n[0].ref.doc_zoho_id === "B1", JSON.stringify(n.map((x) => x.ref.doc_zoho_id)));
check("ltu: 14-day bill within p90 → none", !n.some((x) => x.ref.doc_zoho_id === "B2"));
check("ltu: paid (balance 0) ignored", !n.some((x) => x.ref.doc_zoho_id === "B3"));
check("ltu: title carries days open", /open 75 days/.test(n[0]?.title ?? ""), n[0]?.title);
check("ltu: severity attention, kind later_than_usual", n[0]?.severity === "attention" && n[0]?.kind === "later_than_usual");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
