/**
 * Unit checks for the learned per-vendor judgment checks (pure module).
 * Usage: node --experimental-strip-types scripts/judgment-learned-checks.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  checkRecurringTwiceInPeriod,
  checkAmountAnomaly,
  applySupportingDocumentStrictness,
} = await import(
  pathToFileURL(resolve(root, "supabase/functions/judgment/learned_checks.ts")).href
);

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

// --- recurring twice in period ---
const peersSameMonth = [{ document_id: "aaaaaaaa-1", invoice_date: "2026-08-03", total_amount: 4200 }];
const peersOtherMonth = [{ document_id: "bbbbbbbb-1", invoice_date: "2026-07-03", total_amount: 4200 }];
let r = checkRecurringTwiceInPeriod("2026-08-20", peersSameMonth);
check("twice: fails when a peer is in the same month (even different day)", r.passed === false, r.reason);
r = checkRecurringTwiceInPeriod("2026-08-20", peersOtherMonth);
check("twice: passes when peers are in other months", r.passed === true);
r = checkRecurringTwiceInPeriod("2026-08-20", []);
check("twice: passes with no peers", r.passed === true);
r = checkRecurringTwiceInPeriod(null, peersSameMonth);
check("twice: skips (passes) with no invoice date", r.passed === true && /skipped/.test(r.reason));
r = checkRecurringTwiceInPeriod("2026-08-20", [{ document_id: "c", invoice_date: null, total_amount: 1 }]);
check("twice: peer without a date is ignored", r.passed === true);

// --- amount anomaly, fixed ---
const fixed = { kind: "fixed", median: 4200, tolerance_pct: 5 };
check("fixed: 4200 passes", checkAmountAnomaly(4200, fixed).passed === true);
check("fixed: 4300 (2.4%) passes", checkAmountAnomaly(4300, fixed).passed === true);
r = checkAmountAnomaly(4600, fixed);
check("fixed: 4600 (9.5%) fails", r.passed === false, r.reason);
check("fixed: 42000 (10×) fails", checkAmountAnomaly(42000, fixed).passed === false);
check("fixed: null amount skips", checkAmountAnomaly(null, fixed).passed === true);
check("fixed: missing median skips", checkAmountAnomaly(100, { kind: "fixed" }).passed === true);

// --- amount anomaly, variable ---
const variable = { kind: "variable", p10: 900, p90: 1500, multiplier: 3 };
// centre 1200, half 300 → band 1200 ± 900 = 300..2100
check("variable: 1200 passes", checkAmountAnomaly(1200, variable).passed === true);
check("variable: 2000 passes (inside ×3 band)", checkAmountAnomaly(2000, variable).passed === true);
r = checkAmountAnomaly(2500, variable);
check("variable: 2500 fails (outside ×3 band)", r.passed === false, r.reason);
check("variable: 20000 fails", checkAmountAnomaly(20000, variable).passed === false);
check("variable: 100 fails (below band)", checkAmountAnomaly(100, variable).passed === false);
// degenerate p10 == p90 must not produce a zero-width band
r = checkAmountAnomaly(1010, { kind: "variable", p10: 1000, p90: 1000, multiplier: 3 });
check("variable: p10==p90 still allows small variation", r.passed === true, r.reason);
check("variable: unknown kind skips", checkAmountAnomaly(1, { kind: "weird" }).passed === true);

// --- supporting document strictness ---
r = applySupportingDocumentStrictness(false, { strictness: "relaxed" });
check("relaxed: passes even without a document", r && r.passed === true, r?.reason);
r = applySupportingDocumentStrictness(false, { strictness: "strict", recurring_name_tokens: ["delivery"] });
check("strict: fails without a document, names the token", r && r.passed === false && /delivery/.test(r.reason), r?.reason);
r = applySupportingDocumentStrictness(true, { strictness: "strict" });
check("strict: passes with a document", r && r.passed === true);
r = applySupportingDocumentStrictness(false, { strictness: "standard" });
check("standard: returns null (defer to base check)", r === null);
r = applySupportingDocumentStrictness(false, {});
check("no strictness param: returns null", r === null);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
