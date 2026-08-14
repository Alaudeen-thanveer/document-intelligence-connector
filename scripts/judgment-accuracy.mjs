/**
 * Accuracy check for the 3 hardcoded judgment checks.
 * Seeds 4 scenarios, calls /functions/v1/judgment, prints judgment_results.
 *
 *   node scripts/judgment-accuracy.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      let v = t.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) v = v.slice(1, -1);
      out[t.slice(0, i)] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

const statusEnv = loadEnv(resolve(root, "tmp-supabase.env"));
const projectEnv = loadEnv(resolve(root, ".env"));
const supabaseUrl = statusEnv.API_URL || projectEnv.SUPABASE_URL ||
  "http://127.0.0.1:54321";
const serviceKey = statusEnv.SERVICE_ROLE_KEY ||
  projectEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) {
  console.error("SERVICE_ROLE_KEY missing — run: npx supabase status -o env > tmp-supabase.env");
  process.exit(1);
}

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function rest(path, init = {}) {
  const res = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method || "GET"} ${path} → ${res.status}: ${text}`);
  }
  return body;
}

async function insertDoc(partial) {
  const [doc] = await rest("/rest/v1/documents", {
    method: "POST",
    body: JSON.stringify({
      source: "judgment_accuracy",
      file_url: `https://example.com/fixtures/${partial.label}.pdf`,
      status: "extracted",
      doc_type: "invoice",
      company_id: COMPANY_ID,
      has_supporting_document: partial.has_supporting_document,
      ...partial.docExtra,
    }),
  });
  await rest("/rest/v1/extracted_fields", {
    method: "POST",
    body: JSON.stringify({
      document_id: doc.id,
      doc_type: "invoice",
      vendor_raw: partial.vendor_raw,
      total_amount: partial.total_amount,
      invoice_date: partial.invoice_date,
      po_number: partial.po_number ?? null,
      ai_fallback_used: false,
    }),
  });
  return doc.id;
}

async function runJudgment(documentId) {
  const res = await fetch(`${supabaseUrl}/functions/v1/judgment`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ document_id: documentId }),
  });
  const body = await res.json();
  return { http: res.status, body };
}

// Ensure company judgment config for deterministic thresholds
await rest(
  `/rest/v1/company_config?company_id=eq.${COMPANY_ID}`,
  {
    method: "PATCH",
    body: JSON.stringify({
      duplicate_check_days: 3,
      amount_requires_po_threshold: 1000,
    }),
  },
);

const report = [];

// --- Case A: only duplicate fails ---
const priorDup = await insertDoc({
  label: "dup-prior",
  vendor_raw: "Dup Vendor Co",
  total_amount: 250,
  invoice_date: "2026-08-10",
  has_supporting_document: true,
  po_number: "PO-KEEP",
});
const dupDoc = await insertDoc({
  label: "dup-trigger",
  vendor_raw: "Dup Vendor Co",
  total_amount: 250,
  invoice_date: "2026-08-12", // within 3 days
  has_supporting_document: true,
  po_number: "PO-KEEP",
});
const dupRun = await runJudgment(dupDoc);
report.push({
  case: "A_duplicate_only",
  prior_document_id: priorDup,
  document_id: dupDoc,
  expected_fail: ["duplicate_vendor_amount_date"],
  run: dupRun,
});

// --- Case B: only missing supporting document fails ---
const missingDoc = await insertDoc({
  label: "missing-support",
  vendor_raw: "Support Missing LLC",
  total_amount: 100, // below threshold
  invoice_date: "2026-07-01",
  has_supporting_document: false,
  po_number: null,
});
const missingRun = await runJudgment(missingDoc);
report.push({
  case: "B_missing_supporting_only",
  document_id: missingDoc,
  expected_fail: ["missing_supporting_document"],
  run: missingRun,
});

// --- Case C: only amount-above-threshold-no-PO fails ---
const amountDoc = await insertDoc({
  label: "amount-no-po",
  vendor_raw: "Big Amount Inc",
  total_amount: 5000, // > 1000
  invoice_date: "2026-06-15",
  has_supporting_document: true,
  po_number: null,
});
const amountRun = await runJudgment(amountDoc);
report.push({
  case: "C_amount_no_po_only",
  document_id: amountDoc,
  expected_fail: ["amount_above_threshold_no_po"],
  run: amountRun,
});

// --- Case D: clean pass ---
const cleanDoc = await insertDoc({
  label: "clean-pass",
  vendor_raw: "Clean Vendor Ltd",
  total_amount: 500, // below threshold
  invoice_date: "2026-05-01",
  has_supporting_document: true,
  po_number: "PO-OPTIONAL",
});
const cleanRun = await runJudgment(cleanDoc);
report.push({
  case: "D_clean_all_pass",
  document_id: cleanDoc,
  expected_fail: [],
  run: cleanRun,
});

function summarize(entry) {
  const checks = entry.run.body?.checks ?? [];
  const failed = checks.filter((c) => !c.passed).map((c) => c.rule_name);
  const expected = entry.expected_fail;
  const ok =
    failed.length === expected.length &&
    expected.every((r) => failed.includes(r));
  return {
    case: entry.case,
    document_id: entry.document_id,
    ok,
    expected_fail: expected,
    actual_fail: failed,
    all_passed: entry.run.body?.all_passed,
    judgment_results: entry.run.body?.judgment_results,
    checks,
    error: entry.run.body?.error,
  };
}

const summary = report.map(summarize);
const allOk = summary.every((s) => s.ok && !s.error);

console.log(JSON.stringify({ allOk, config: { duplicate_check_days: 3, amount_requires_po_threshold: 1000 }, cases: summary }, null, 2));
process.exit(allOk ? 0 : 1);
