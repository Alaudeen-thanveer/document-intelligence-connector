/**
 * Bank layer 1 accuracy check: description fingerprints → learned patterns
 * → matching, including the "nothing suggestible" gate.
 * Usage: node --experimental-strip-types scripts/bk-bank-layer1-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  tokenizeDescription, fingerprintDescription, buildBankPatterns, matchBankPattern,
  isBankMatchSuggestible, bankPatternConfidence, MIN_BANK_PATTERN_SAMPLE, BANK_SUGGEST_MIN_CONFIDENCE,
} = await import(pathToFileURL(resolve(root, "supabase/functions/bookkeeping-learn/bank_patterns.ts")).href);

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- tokenizing
console.log("— tokenizing —");
check("strips POS boilerplate, terminal id, city, country",
  eq(tokenizeDescription("POS PURCHASE ETISALAT 044556 DUBAI AE"), ["ETISALAT"]),
  JSON.stringify(tokenizeDescription("POS PURCHASE ETISALAT 044556 DUBAI AE")));
check("keeps counterparty words, drops ref numbers",
  eq(tokenizeDescription("INWARD TT ACME RETAIL GRP REF 88213"), ["ACME", "GRP", "RETAIL"]));
check("order-independent",
  fingerprintDescription("ETISALAT POS 1234") === fingerprintDescription("POS 5678 ETISALAT"));
check("date-like and mixed tokens dropped", eq(tokenizeDescription("TRF 12AUG26 T02 ABC1234 LANDLORD PROPERTIES"), ["LANDLORD", "PROPERTIES"]));
check("nothing identifying → empty fingerprint", fingerprintDescription("CHQ 000123 12/08/2026") === "");
check("company suffix kept to split similar names",
  !eq(tokenizeDescription("GULF TRADING LLC"), tokenizeDescription("GULF TRADING FZCO")));

// ---------------------------------------------------------------- history
const obs = [];
const O = (description, side, amount, date, txn_kind, party_kind, party_zoho_id, party_name, account_id, account_name, source = "zoho_bank") =>
  obs.push({ description, side, amount, date, txn_kind, party_kind, party_zoho_id, party_name, account_id, account_name, source });

// A: 12 Etisalat POS debits, always Telephone Expense, amounts 900–1500
for (let m = 1; m <= 12; m++) O(`POS PURCHASE ETISALAT ${44000 + m} DUBAI AE`, "debit", 900 + m * 40, `2026-${String(m).padStart(2, "0")}-04`, "expense", "vendor", "V-ETI", "Etisalat Business", "A-TEL", "Telephone Expense");
// B: 8 inward remittances from Acme — customer payments, deposited to bank; ref numbers vary
for (let m = 1; m <= 8; m++) O(`INWARD TT ACME RETAIL GRP REF ${88000 + m} VALUE DATE 15${m}26`, "credit", 5000, `2026-0${m}-16`, "customer_payment", "customer", "C-ACME", "Acme Retail Group", null, null, "zoho_payment");
// C: bank charges — 10 debits, no party, Bank Fees account; description drifts a little
for (let m = 1; m <= 10; m++) O(m % 2 ? `MONTHLY ACCOUNT MAINTENANCE FEE` : `ACCOUNT MAINTENANCE CHARGES ${m}`, "debit", 52.5, `2026-${String(m).padStart(2, "0")}-01`, "expense", null, null, null, "A-BANKFEE", "Bank Fees and Charges");
// D: split habit — "GULF TRADING LLC" debits went to Cargo 3× and Consultant 3× (share 0.5)
for (let m = 1; m <= 6; m++) O(`TRF TO GULF TRADING LLC INV ${m}`, "debit", 1000, `2026-0${m}-20`, "vendor_payment", "vendor", "V-GULF", "Gulf Trading LLC", m % 2 ? "A-CARGO" : "A-CONS", m % 2 ? "Cargo Expense" : "Consultant Expense");
// E: same counterparty, opposite side — a REFUND from Etisalat (credit) → should not collide with A
O("ETISALAT REFUND 4432", "credit", 120, "2026-03-11", "deposit", "vendor", "V-ETI", "Etisalat Business", "A-TEL", "Telephone Expense");
O("ETISALAT REFUND 4499", "credit", 80, "2026-06-11", "deposit", "vendor", "V-ETI", "Etisalat Business", "A-TEL", "Telephone Expense");
// F: singleton — below MIN sample, must not become a pattern
O("SALARY WPS AUG BATCH 22", "debit", 48000, "2026-08-28", "expense", null, null, null, "A-SAL", "Salaries and Employee Wages");
// G: a confirmed line from this app counts like any other observation
O("DEWA BILL PAYMENT 998877", "debit", 610, "2026-07-03", "expense", "vendor", "V-DEWA", "DEWA", "A-UTIL", "Utilities", "confirmed_line");
O("DEWA 998878", "debit", 640, "2026-08-03", "expense", "vendor", "V-DEWA", "DEWA", "A-UTIL", "Utilities", "confirmed_line");

const patterns = buildBankPatterns(obs);
const byFp = (fp, side) => patterns.find((p) => p.fingerprint === fp && p.side === side);

console.log("\n— building patterns —");
check(`MIN sample is ${MIN_BANK_PATTERN_SAMPLE}; singleton salary line produced no pattern`, !patterns.some((p) => p.account_id === "A-SAL"));
const A = byFp("ETISALAT", "debit");
check("Etisalat POS → one debit pattern, 12 samples, share 1", A && A.sample_size === 12 && A.share === 1, A && `n=${A.sample_size} share=${A.share} conf=${A.confidence}`);
check("  → Telephone Expense, vendor Etisalat, kind expense", A && A.account_id === "A-TEL" && A.party_zoho_id === "V-ETI" && A.txn_kind === "expense");
check("  → confidence 0.92 (12 unanimous)", A && A.confidence === bankPatternConfidence(1, 12) && A.confidence === 0.92, A && String(A.confidence));
check("  → amount band 940–1380 (p10..p90)", A && A.amount_p10 >= 940 && A.amount_p90 <= 1400, A && `${A.amount_p10}..${A.amount_p90}`);
check("  → keeps up to 3 raw examples", A && A.examples.length === 3 && A.examples[0].startsWith("POS PURCHASE ETISALAT"));
const E = byFp("ETISALAT REFUND", "credit");
check("Etisalat refund is a SEPARATE credit-side pattern (n=2)", E && E.sample_size === 2 && E.txn_kind === "deposit");
const B = byFp("ACME GRP RETAIL", "credit");
check("Acme inward remittances → customer_payment pattern despite changing refs/dates", B && B.sample_size === 8 && B.txn_kind === "customer_payment" && B.party_zoho_id === "C-ACME", B && `n=${B.sample_size}`);
const C1 = byFp("ACCOUNT MAINTENANCE", "debit");
check("Bank charges: 'FEE'/'CHARGES' are boilerplate, so both wordings collapse to one pattern (n=10)", C1 && C1.sample_size === 10 && C1.account_id === "A-BANKFEE" && C1.party_kind === null, C1 && `n=${C1.sample_size}`);
const D = byFp("GULF LLC TRADING", "debit");
check("Gulf Trading: split habit → share 0.5, confidence 0.43", D && D.share === 0.5 && D.confidence === bankPatternConfidence(0.5, 6), D && `share=${D.share} conf=${D.confidence}`);
const G = byFp("DEWA", "debit");
check("Confirmed lines from this app learn like Zoho history (DEWA n=2)", G && G.sample_size === 2 && G.account_id === "A-UTIL", G && `n=${G.sample_size}`);
check("Patterns sorted by evidence", patterns[0].sample_size >= patterns[patterns.length - 1].sample_size);

// ---------------------------------------------------------------- matching
console.log("\n— matching new statement lines —");
const m1 = matchBankPattern("POS PURCHASE ETISALAT 044999 DUBAI AE", "debit", patterns);
check("new Etisalat POS line matches, score 0.92, suggestible", isBankMatchSuggestible(m1) && m1.pattern.fingerprint === "ETISALAT" && m1.score === 0.92, m1 && `score=${m1.score}`);
const m2 = matchBankPattern("ETISALAT 044999", "credit", patterns);
check("same words on the CREDIT side match the refund pattern, not the POS one", m2 && m2.pattern.fingerprint === "ETISALAT REFUND" ? false : (m2 === null || m2.pattern.side === "credit"), m2 && `fp=${m2.pattern.fingerprint} side=${m2.pattern.side}`);
const m2b = matchBankPattern("ETISALAT REFUND 5511", "credit", patterns);
check("Etisalat refund line → refund pattern (credit), score 0.67, suggestible", isBankMatchSuggestible(m2b) && m2b.pattern.fingerprint === "ETISALAT REFUND" && m2b.score === 0.67, m2b && `score=${m2b.score}`);
const m3 = matchBankPattern("INWARD TT ACME RETAIL GRP REF 90001", "credit", patterns);
check("Acme remittance → customer_payment, score 0.89", isBankMatchSuggestible(m3) && m3.pattern.txn_kind === "customer_payment" && m3.score === 0.89, m3 && `score=${m3.score}`);
const m3b = matchBankPattern("ACME RETAIL GROUP LLC PAYMENT", "credit", patterns);
check("partial wording (2 of 3 pattern tokens) still matches a 3-token pattern at 2/3 coverage", m3b && m3b.pattern.fingerprint === "ACME GRP RETAIL" && Math.abs(m3b.coverage - 2 / 3) < 1e-9, m3b && `coverage=${m3b.coverage.toFixed(2)} score=${m3b.score}`);
const m4 = matchBankPattern("TRF TO GULF TRADING LLC INV 7", "debit", patterns);
check(`Gulf Trading split habit (0.43) is BELOW the ${BANK_SUGGEST_MIN_CONFIDENCE} gate → not suggestible, line stays open`, m4 && !isBankMatchSuggestible(m4), m4 && `score=${m4.score}`);
const m5 = matchBankPattern("SALARY WPS SEP BATCH 23", "debit", patterns);
check("salary line: no pattern (singleton history) → null → nothing suggested", m5 === null);
const m6 = matchBankPattern("CHQ 000456", "debit", patterns);
check("cheque with no words → null", m6 === null);
const m7 = matchBankPattern("ETISALAT", "debit", patterns);
check("bare word 'ETISALAT' matches only the exact 1-token pattern (not partial matches to longer ones)", m7 && m7.pattern.fingerprint === "ETISALAT");
const m8 = matchBankPattern("GULF TRADING", "debit", patterns);
check("'GULF TRADING' (2 of 3 tokens of a 3-token pattern) qualifies at 2/3 but stays under the gate", m8 && Math.abs(m8.coverage - 2 / 3) < 1e-9 && !isBankMatchSuggestible(m8), m8 && `score=${m8.score}`);
const m9 = matchBankPattern("ACCOUNT MAINTENANCE FEE SEP", "debit", patterns);
check("bank charge line → Bank Fees, no party, score 0.91", isBankMatchSuggestible(m9) && m9.pattern.account_id === "A-BANKFEE" && m9.pattern.party_kind === null && m9.score === 0.91, m9 && `score=${m9.score}`);
const m10 = matchBankPattern("DEWA 998879", "debit", patterns);
check("DEWA (learned from 2 confirmed lines) → Utilities, score 0.67 — just over the gate", isBankMatchSuggestible(m10) && m10.pattern.account_id === "A-UTIL" && m10.score === 0.67, m10 && `score=${m10.score}`);

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"} · ${patterns.length} patterns from ${obs.length} observations`);
process.exit(failures === 0 ? 0 : 1);
