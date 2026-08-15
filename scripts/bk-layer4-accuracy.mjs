/**
 * Layer 4 accuracy check: reporting tags + projects per party, and per
 * account for journals. Synthetic history with KNOWN truth.
 * Usage: node --experimental-strip-types scripts/bk-layer4-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  learnPartyTagProfiles,
  learnJournalTagUsage,
  isTagProposable,
  isProjectProposable,
  parseZohoLineTags,
  MIN_TAG_SAMPLE,
} = await import(
  pathToFileURL(resolve(root, "supabase/functions/bookkeeping-learn/tags_projects.ts")).href
);

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

const DEPT = { tag_id: "T-DEPT", tag_name: "Department" };
const OPS = { tag_option_id: "O-OPS", tag_option_name: "Operations" };
const ADMIN = { tag_option_id: "O-ADMIN", tag_option_name: "Admin" };
const LOC = { tag_id: "T-LOC", tag_name: "Location" };
const DXB = { tag_option_id: "O-DXB", tag_option_name: "Dubai" };
const WH = { project_id: "P-WH", project_name: "Warehouse Expansion" };

const docs = [];
// Falcon: 20 bills; lines tagged Dept=Operations (18) / Admin (2), Loc=Dubai always, project WH on 16.
for (let i = 0; i < 20; i++) {
  docs.push({
    doc_kind: "bill", zoho_id: `b${i}`, party_zoho_id: "V-FALCON", party_name: "Falcon", date: "2026-01-10",
    total: 100, currency: "AED", tax_treatment: null, payment_terms_id: null, has_po: false,
    line_items: [{
      account_id: "A1", account_name: "Cargo", amount: 100,
      tags: [{ ...DEPT, ...(i < 18 ? OPS : ADMIN) }, { ...LOC, ...DXB }],
      ...(i < 16 ? WH : {}),
    }],
  });
}
// Falcon also has 5 EXPENSES (vendor party) tagged Ops — should merge into the same vendor profile.
for (let i = 0; i < 5; i++) {
  docs.push({
    doc_kind: "expense", zoho_id: `e${i}`, party_zoho_id: "V-FALCON", party_name: "Falcon", date: "2026-02-01",
    total: 50, currency: "AED", tax_treatment: null, payment_terms_id: null, has_po: false,
    line_items: [{ account_id: "A1", account_name: "Cargo", amount: 50, tags: [{ ...DEPT, ...OPS }] }],
  });
}
// Acme customer: 10 invoices, no tags, no project.
for (let i = 0; i < 10; i++) {
  docs.push({
    doc_kind: "invoice", zoho_id: `i${i}`, party_zoho_id: "C-ACME", party_name: "Acme", date: "2026-03-01",
    total: 500, currency: "AED", tax_treatment: null, payment_terms_id: null, has_po: false,
    line_items: [{ account_id: "A-SALES", account_name: "Sales", amount: 500, tags: [] }],
  });
}
// Journals: 12 monthly depreciation entries; Depreciation Expense line tagged Dept=Admin.
for (let i = 0; i < 12; i++) {
  docs.push({
    doc_kind: "journal", zoho_id: `j${i}`, party_zoho_id: "", party_name: "", date: `2026-${String(i + 1).padStart(2, "0")}-28`,
    total: 1250, currency: "AED", tax_treatment: null, payment_terms_id: null, has_po: false,
    line_items: [
      { account_id: "A-DEP", account_name: "Depreciation Expense", amount: 1250, tags: [{ ...DEPT, ...ADMIN }] },
      { account_id: "A-ACC", account_name: "Accumulated Depreciation", amount: -1250, tags: [] },
    ],
  });
}
// Thin vendor: 2 bills, tagged — below MIN.
for (let i = 0; i < 2; i++) {
  docs.push({
    doc_kind: "bill", zoho_id: `t${i}`, party_zoho_id: "V-THIN", party_name: "Thin", date: "2026-01-01",
    total: 10, currency: "AED", tax_treatment: null, payment_terms_id: null, has_po: false,
    line_items: [{ account_id: "A1", account_name: "Cargo", amount: 10, tags: [{ ...DEPT, ...OPS }] }],
  });
}

const profiles = learnPartyTagProfiles(docs);
const byId = Object.fromEntries(profiles.map((p) => [p.party_zoho_id, p]));

const F = byId["V-FALCON"];
check("Falcon profile merges bills + expenses (25 docs)", F?.doc_sample_size === 25, F?.doc_sample_size);
check("Falcon line sample = 25", F?.line_sample_size === 25);
const dept = F?.tags.find((t) => t.tag_id === "T-DEPT");
check("Falcon Dept dominant = Operations", dept?.option_id === "O-OPS", dept?.option_name);
check("Falcon Dept share = 23/25 = 0.92", dept && Math.abs(dept.share - 0.92) < 0.001, dept?.share);
check("Falcon Dept proposable", dept && isTagProposable(dept));
const loc = F?.tags.find((t) => t.tag_id === "T-LOC");
check("Falcon Location = Dubai on 20 lines (bills only)", loc?.option_id === "O-DXB" && loc.lines === 20, `${loc?.option_name} n=${loc?.lines}`);
check("Falcon Location share = 1.0", loc?.share === 1);
check("Falcon project = Warehouse Expansion", F?.project?.project_id === "P-WH", F?.project?.project_name);
check("Falcon project share = 16/25 = 0.64", F && Math.abs(F.project.share - 0.64) < 0.001, F?.project?.share);
check("Falcon project NOT proposable (share < 0.7)", F && !isProjectProposable(F.project, F.line_sample_size));
check("Falcon tags sorted by lines desc (Dept 25 first)", F?.tags[0]?.tag_id === "T-DEPT");

const A = byId["C-ACME"];
check("Acme profiled as customer", A?.party_kind === "customer");
check("Acme has no tags", A?.tags.length === 0);
check("Acme project null", A?.project === null);

const T = byId["V-THIN"];
check("Thin Dept exists but NOT proposable", T && !isTagProposable(T.tags[0]), `lines=${T?.tags[0]?.lines} < ${MIN_TAG_SAMPLE}`);

check("Journals produce no party profile", !profiles.some((p) => p.party_zoho_id === ""));

const jt = learnJournalTagUsage(docs);
const depTag = jt.find((u) => u.account_id === "A-DEP");
check("Journal: Depreciation Expense → Dept=Admin", depTag?.option_id === "O-ADMIN", depTag?.option_name);
check("Journal: 12 lines, share 1.0", depTag?.lines === 12 && depTag.share === 1);
check("Journal: Accumulated Depreciation (untagged) absent", !jt.some((u) => u.account_id === "A-ACC"));

// parseZohoLineTags
const parsed = parseZohoLineTags([
  { tag_id: 1, tag_name: "Department", tag_option_id: 2, tag_option_name: "Ops" },
  { tag_id: 3, tag_option_id: "" }, // incomplete → dropped
]);
check("parseZohoLineTags keeps complete, drops incomplete", parsed.length === 1 && parsed[0].tag_id === "1" && parsed[0].tag_option_id === "2");
check("parseZohoLineTags non-array → []", parseZohoLineTags(null).length === 0);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
