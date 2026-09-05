/**
 * Layer 2 accuracy check: recurrence cadence.
 * Synthetic series with KNOWN cadences → classifyRhythm / proposeChecks.
 *
 * Usage: node --experimental-strip-types scripts/bk-layer2-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { classifyRhythm, proposeChecks, MIN_SERIES } = await import(
  pathToFileURL(
    resolve(root, "supabase/functions/bookkeeping-learn/recurrence.ts"),
  ).href
);

function ymd(monthsAgo, day) {
  const d = new Date(Date.UTC(2026, 7, day));
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 10);
}

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

// Rent: 24 months, day 1–3, always 4200 → fixed_recurring.
const rent = classifyRhythm(
  Array.from({ length: 24 }, (_, m) => ({ date: ymd(m, 1 + (m % 3)), total: 4200 })),
);
check("rent cadence = fixed_recurring", rent.cadence === "fixed_recurring", rent.cadence);
check("rent coverage = 1.0", rent.monthly_coverage === 1, rent.monthly_coverage);
check("rent cv = 0", rent.amount_cv === 0, rent.amount_cv);
check("rent day window 1–3", rent.expected_day_min === 1 && rent.expected_day_max === 3, `${rent.expected_day_min}–${rent.expected_day_max}`);
check("rent next_expected = month after last_seen", rent.next_expected === "2026-09-01", rent.next_expected);
check("rent confidence high (>0.9)", rent.confidence > 0.9, rent.confidence);
const rentChecks = proposeChecks(rent);
check("rent proposes 3 checks", rentChecks.length === 3, rentChecks.map((c) => c.check_kind).join(","));
check("rent anomaly params kind=fixed, median 4200", rentChecks.find((c) => c.check_kind === "amount_anomaly")?.params.kind === "fixed" && rentChecks.find((c) => c.check_kind === "amount_anomaly")?.params.median === 4200);

// Utility: 24 months, day 8–12, amount 900–1500 → variable_recurring.
const util = classifyRhythm(
  Array.from({ length: 24 }, (_, m) => ({ date: ymd(m, 8 + (m % 5)), total: 900 + ((m * 137) % 600) })),
);
check("utility cadence = variable_recurring", util.cadence === "variable_recurring", util.cadence);
check("utility cv > 0.02", util.amount_cv > 0.02, util.amount_cv);
const utilChecks = proposeChecks(util);
check("utility anomaly params kind=variable with p10/p90", utilChecks.find((c) => c.check_kind === "amount_anomaly")?.params.kind === "variable");
check("utility proposes expected_missing", utilChecks.some((c) => c.check_kind === "expected_missing"));

// Utility with 2 missed months out of 24 → still monthly (coverage ≥ 0.75).
// Amounts genuinely vary (900–1500) so it stays "variable", not "fixed".
const utilGaps = classifyRhythm(
  Array.from({ length: 24 }, (_, m) => (m === 5 || m === 13 ? null : { date: ymd(m, 10), total: 900 + ((m * 137) % 600) }))
    .filter(Boolean),
);
check("2 missed months still variable_recurring", utilGaps.cadence === "variable_recurring", `${utilGaps.cadence} cov=${utilGaps.monthly_coverage}`);
check("2 missed months coverage ≈ 0.917", Math.abs(utilGaps.monthly_coverage - 22 / 24) < 0.01, utilGaps.monthly_coverage);

// Same shape but nearly-constant amounts (±0.5%) → correctly "fixed".
const nearFixed = classifyRhythm(
  Array.from({ length: 24 }, (_, m) => ({ date: ymd(m, 10), total: 1000 + (m % 2) * 5 })),
);
check("±0.5% amounts classified fixed_recurring", nearFixed.cadence === "fixed_recurring", `${nearFixed.cadence} cv=${nearFixed.amount_cv}`);

// Project vendor: 6 bills scattered over 24 months → irregular.
const proj = classifyRhythm(
  [0, 3, 4, 11, 17, 22].map((m) => ({ date: ymd(m, 15), total: 5000 + m * 100 })),
);
check("project cadence = irregular", proj.cadence === "irregular", `${proj.cadence} cov=${proj.monthly_coverage}`);
check("project proposes NO checks", proposeChecks(proj).length === 0);
check("project still has amount stats", proj.amount_median != null);

// Thin: 3 bills → insufficient.
const thin = classifyRhythm([0, 1, 2].map((m) => ({ date: ymd(m, 10), total: 100 })));
check("3 bills = insufficient (< MIN_SERIES)", thin.cadence === "insufficient", `n=3 < ${MIN_SERIES}`);
check("insufficient confidence 0", thin.confidence === 0);
check("insufficient proposes nothing", proposeChecks(thin).length === 0);

// Multiple bills in one month (dup scenario) counted once per month.
const dupMonth = classifyRhythm([
  ...Array.from({ length: 12 }, (_, m) => ({ date: ymd(m, 10), total: 300 })),
  { date: ymd(2, 20), total: 300 }, // extra in month 2
]);
check("extra bill in one month doesn't break coverage (=1.0)", dupMonth.monthly_coverage === 1, dupMonth.monthly_coverage);
check("dup-month sample_size = 13", dupMonth.sample_size === 13);

// Bad dates ignored.
const bad = classifyRhythm([{ date: "not-a-date", total: 5 }, { date: ymd(0, 1), total: 5 }]);
check("invalid dates dropped", bad.sample_size === 1);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
