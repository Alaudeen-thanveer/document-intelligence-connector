/**
 * Layer 5 accuracy check: manual journal patterns.
 * Usage: node --experimental-strip-types scripts/bk-layer5-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { fingerprintJournal, findJournalPatterns, isJournalPatternProposable, MIN_JOURNAL_PATTERN_SAMPLE } = await import(
  pathToFileURL(resolve(root, "supabase/functions/bookkeeping-learn/journal_patterns.ts")).href
);

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const L = (account_id, account_name, debit, credit) => ({ account_id, account_name, debit, credit });

const journals = [];
// Pattern P: 12 monthly manual accruals — Dr Accrued Expenses / Cr Accruals Payable, 800 each, last day of month.
for (let m = 1; m <= 12; m++) {
  const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
  journals.push({ journal_id: `ACC${m}`, date: `2026-${String(m).padStart(2, "0")}-${last}`, reference_number: null,
    notes: `Monthly accrual ${m}/2026`, total: 800, from_recurring: false,
    lines: [L("A-ACCEXP", "Accrued Expenses", 800, 0), L("A-ACCPAY", "Accruals Payable", 0, 800)] });
}
// Pattern Q: 6 monthly prepayment releases, amount varies — Dr Rent Expense / Cr Prepaid Rent.
for (let m = 1; m <= 6; m++) {
  journals.push({ journal_id: `PRE${m}`, date: `2026-0${m}-01`, reference_number: "PREPAY", notes: null,
    total: 1000 + m * 30, from_recurring: false,
    lines: [L("A-RENT", "Rent Expense", 1000 + m * 30, 0), L("A-PREPAID", "Prepaid Rent", 0, 1000 + m * 30)] });
}
// Declared recurring depreciation — 12 entries — must be EXCLUDED (from_recurring).
for (let m = 1; m <= 12; m++) {
  journals.push({ journal_id: `DEP${m}`, date: `2026-${String(m).padStart(2, "0")}-28`, reference_number: null,
    notes: "Monthly depreciation", total: 1250, from_recurring: true,
    lines: [L("A-DEP", "Depreciation Expense", 1250, 0), L("A-ACCDEP", "Accumulated Depreciation", 0, 1250)] });
}
// One-off correction — single occurrence, must not be proposable.
journals.push({ journal_id: "FIX1", date: "2026-03-15", reference_number: null, notes: "Correction", total: 42,
  from_recurring: false, lines: [L("A-MISC", "Misc", 42, 0), L("A-BANK", "Bank", 0, 42)] });
// Same accounts as P but sides REVERSED (a reversal) → different fingerprint, 2 occurrences → not proposable.
for (let m = 1; m <= 2; m++) {
  journals.push({ journal_id: `REV${m}`, date: `2026-0${m}-02`, reference_number: null, notes: "Reverse accrual", total: 800,
    from_recurring: false, lines: [L("A-ACCPAY", "Accruals Payable", 800, 0), L("A-ACCEXP", "Accrued Expenses", 0, 800)] });
}
// Bad date ignored.
journals.push({ journal_id: "BAD", date: "not-a-date", reference_number: null, notes: null, total: 1, from_recurring: false,
  lines: [L("A-MISC", "Misc", 1, 0), L("A-BANK", "Bank", 0, 1)] });

check("fingerprint is order-independent", fingerprintJournal(journals[0]) === fingerprintJournal({ ...journals[0], lines: [...journals[0].lines].reverse() }));
check("fingerprint distinguishes sides", fingerprintJournal(journals[0]) !== fingerprintJournal(journals.find((j) => j.journal_id === "REV1")));

const patterns = findJournalPatterns(journals);
const byLabel = Object.fromEntries(patterns.map((p) => [p.label, p]));

const P = byLabel["Dr Accrued Expenses / Cr Accruals Payable"];
check("accrual pattern found", !!P);
check("accrual: 12 occurrences", P?.sample_size === 12);
check("accrual: fixed_recurring", P?.cadence === "fixed_recurring", P?.cadence);
check("accrual: amount median 800", P?.amount_median === 800);
check("accrual: day window at month end (≥ 28)", P && P.expected_day_min >= 28, `${P?.expected_day_min}–${P?.expected_day_max}`);
check("accrual: recurring note detected (dates stripped)", /monthly accrual/i.test(P?.recurring_note ?? ""), P?.recurring_note);
check("accrual: proposable", P && isJournalPatternProposable(P));
check("accrual: next_expected 2027-01-01", P?.next_expected === "2027-01-01", P?.next_expected);
check("accrual: last 3 example ids", P?.example_journal_ids?.length === 3 && P.example_journal_ids.includes("ACC12"));

const Q = byLabel["Dr Rent Expense / Cr Prepaid Rent"];
check("prepayment pattern found, 6 occurrences", Q?.sample_size === 6);
check("prepayment: variable_recurring (amount varies)", Q?.cadence === "variable_recurring", Q?.cadence);
check("prepayment: proposable", Q && isJournalPatternProposable(Q));

check("declared recurring depreciation EXCLUDED", !patterns.some((p) => p.label.includes("Depreciation")));
const R = byLabel["Dr Accruals Payable / Cr Accrued Expenses"];
check("reversal is a separate pattern (2 occurrences)", R?.sample_size === 2);
check("reversal NOT proposable (< MIN)", R && !isJournalPatternProposable(R), `n=2 < ${MIN_JOURNAL_PATTERN_SAMPLE}`);
const F = byLabel["Dr Misc / Cr Bank"];
check("one-off correction: 1 occurrence, not proposable (bad-date twin ignored)", F?.sample_size === 1 && !isJournalPatternProposable(F));
check("patterns sorted by sample_size desc", patterns[0].sample_size >= patterns[patterns.length - 1].sample_size);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
