/**
 * Layer 1 accuracy check: party → account profiles.
 *
 * Builds a synthetic 24-month history with KNOWN ground truth, runs the
 * pure analysis (same code the edge function uses), and asserts every
 * claim in docs/BOOKKEEPING_PATTERNS_SPEC.md §3.1. No network, no Zoho.
 *
 * Usage: node --experimental-strip-types scripts/bk-layer1-accuracy.mjs
 * (Node ≥ 22.6; the analysis module is TypeScript with no build step.)
 * Exit 0 = all assertions pass.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  buildPartyProfiles,
  isProposable,
  isSplitParty,
  profileConfidence,
  MIN_SAMPLE_FOR_PROPOSAL,
} = await import(
  pathToFileURL(
    resolve(root, "supabase/functions/bookkeeping-learn/analyze.ts"),
  ).href
);

// ---------------------------------------------------------------------------
// Synthetic history with known truth.
// ---------------------------------------------------------------------------
const CARGO = { id: "A-CARGO", name: "Cargo Expense Account" };
const CONSULT = { id: "A-CONSULT", name: "Consultant Expense" };
const RENT = { id: "A-RENT", name: "Rent Expense" };
const SALES = { id: "A-SALES", name: "Sales" };

function ymd(monthsAgo, day = 10) {
  const d = new Date(Date.UTC(2026, 7, day)); // Aug 2026 baseline
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 10);
}

const docs = [];

// Vendor A: Falcon — 24 monthly bills, 22 lines to Cargo, 2 to Consultant.
// Truth: dominant Cargo, share ≈ 0.917, high confidence, NOT split.
for (let m = 0; m < 24; m++) {
  const acct = m % 12 === 5 ? CONSULT : CARGO;
  docs.push({
    doc_kind: "bill", zoho_id: `F${m}`, party_zoho_id: "V-FALCON",
    party_name: "Falcon Logistics FZE", date: ymd(m), total: 400 + m * 5,
    currency: "AED", tax_treatment: "vat_registered", payment_terms_id: "PT30",
    has_po: m % 3 === 0,
    line_items: [{ account_id: acct.id, account_name: acct.name, amount: 400 + m * 5 }],
  });
}

// Vendor B: Mixed Traders — 12 bills, each with 2 lines: one Cargo, one
// Consultant. Truth: split party (share 0.5), needs line-level attention.
for (let m = 0; m < 12; m++) {
  docs.push({
    doc_kind: "bill", zoho_id: `M${m}`, party_zoho_id: "V-MIXED",
    party_name: "Mixed Traders LLC", date: ymd(m), total: 1000,
    currency: "AED", tax_treatment: "vat_registered", payment_terms_id: "PT15",
    has_po: true,
    line_items: [
      { account_id: CARGO.id, account_name: CARGO.name, amount: 600 },
      { account_id: CONSULT.id, account_name: CONSULT.name, amount: 400 },
    ],
  });
}

// Vendor C: Seen Once — 1 bill. Truth: below MIN_SAMPLE, not proposable.
docs.push({
  doc_kind: "bill", zoho_id: "S0", party_zoho_id: "V-ONCE",
  party_name: "Seen Once WLL", date: ymd(2), total: 99,
  currency: "AED", tax_treatment: null, payment_terms_id: null, has_po: false,
  line_items: [{ account_id: RENT.id, account_name: RENT.name, amount: 99 }],
});

// Vendor D: Landlord — 24 bills, all Rent, always same amount 4200.
// Truth: share 1.0, p10 = p90 = 4200.
for (let m = 0; m < 24; m++) {
  docs.push({
    doc_kind: "bill", zoho_id: `L${m}`, party_zoho_id: "V-LANDLORD",
    party_name: "Landlord Properties", date: ymd(m, 1), total: 4200,
    currency: "AED", tax_treatment: "vat_registered", payment_terms_id: "PT0",
    has_po: false,
    line_items: [{ account_id: RENT.id, account_name: RENT.name, amount: 4200 }],
  });
}

// Customer X: 10 invoices to Sales. Truth: customer profile, dominant Sales.
for (let m = 0; m < 10; m++) {
  docs.push({
    doc_kind: "invoice", zoho_id: `I${m}`, party_zoho_id: "C-ACME",
    party_name: "Acme Retail", date: ymd(m), total: 2500,
    currency: "AED", tax_treatment: "vat_registered", payment_terms_id: "PT30",
    has_po: false,
    line_items: [{ account_id: SALES.id, account_name: SALES.name, amount: 2500 }],
  });
}

// ---------------------------------------------------------------------------
const profiles = buildPartyProfiles(docs);
const byId = Object.fromEntries(profiles.map((p) => [p.party_zoho_id, p]));

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

const F = byId["V-FALCON"];
check("Falcon profiled as vendor", F && F.party_kind === "vendor");
check("Falcon dominant = Cargo", F?.dominant_account_id === CARGO.id, `got ${F?.dominant_account_name}`);
check("Falcon share ≈ 0.917", F && Math.abs(F.account_share - 22 / 24) < 0.01, `share=${F?.account_share}`);
check("Falcon sample_size = 24", F?.sample_size === 24);
check("Falcon confidence high (>0.85)", F && F.confidence > 0.85, `conf=${F?.confidence}`);
check("Falcon NOT split", F && !isSplitParty(F));
check("Falcon proposable", F && isProposable(F));
check("Falcon tax_treatment mode = vat_registered", F?.tax_treatment === "vat_registered");
check("Falcon currency = AED", F?.currency === "AED");
check("Falcon payment_terms = PT30", F?.payment_terms_id === "PT30");
check("Falcon po_usually_present = false (1 in 3)", F?.po_usually_present === false);
check("Falcon first_seen < last_seen", F && F.first_seen < F.last_seen, `${F?.first_seen} → ${F?.last_seen}`);
check("Falcon account_split has 2 entries, Cargo first", F?.account_split?.length === 2 && F.account_split[0].account_id === CARGO.id);

const M = byId["V-MIXED"];
check("Mixed share = 0.5", M && Math.abs(M.account_share - 0.5) < 0.001, `share=${M?.account_share}`);
check("Mixed IS split", M && isSplitParty(M));
check("Mixed line_sample_size = 24 (12×2)", M?.line_sample_size === 24);
check("Mixed po_usually_present = true", M?.po_usually_present === true);
check("Mixed confidence lower than Falcon", M && F && M.confidence < F.confidence, `${M?.confidence} < ${F?.confidence}`);

const O = byId["V-ONCE"];
check("Seen-once profile exists", !!O);
check("Seen-once NOT proposable (below MIN_SAMPLE)", O && !isProposable(O), `n=${O?.sample_size} < ${MIN_SAMPLE_FOR_PROPOSAL}`);
check("Seen-once confidence low (<0.2)", O && O.confidence < 0.2, `conf=${O?.confidence}`);

const L = byId["V-LANDLORD"];
check("Landlord share = 1.0", L?.account_share === 1);
check("Landlord p10 = p90 = median = 4200", L && L.amount_p10 === 4200 && L.amount_p90 === 4200 && L.amount_median === 4200);
check("Landlord confidence ≈ 0.95 (share 1 × evidence(24))", L && Math.abs(L.confidence - profileConfidence(1, 24)) < 0.001, `conf=${L?.confidence}`);

const A = byId["C-ACME"];
check("Acme profiled as customer (from invoices)", A && A.party_kind === "customer");
check("Acme dominant = Sales", A?.dominant_account_id === SALES.id);
check("Acme proposable", A && isProposable(A));

check("Profiles sorted by sample_size desc", profiles[0].sample_size >= profiles[profiles.length - 1].sample_size);
check("Exactly 5 parties profiled", profiles.length === 5, `got ${profiles.length}`);

// Confidence curve sanity.
check("confidence(1, 3) ≈ 0.31", Math.abs(profileConfidence(1, 3) - 0.313) < 0.01, profileConfidence(1, 3));
check("confidence(0.9, 40) ≈ 0.89", Math.abs(profileConfidence(0.9, 40) - 0.894) < 0.01, profileConfidence(0.9, 40));
check("confidence(x, 0) = 0", profileConfidence(1, 0) === 0);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${profiles.length} profiles from ${docs.length} synthetic documents`);
process.exit(failures === 0 ? 0 : 1);
