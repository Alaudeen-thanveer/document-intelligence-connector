/**
 * Accuracy check: simulate a Mailgun inbound email with an invoice PDF
 * attached to the company's unique address, then prove the resulting
 * documents row matches a manual-upload shape (source differs only).
 *
 * Usage:
 *   node scripts/inbound-email-accuracy.mjs [path/to/invoice.pdf]
 *
 * Requires: supabase start + npm run functions:serve --env-file .env
 * with MAILGUN_WEBHOOK_SKIP_VERIFY=true
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadEnv(resolve(root, ".env"));

const SUPABASE_URL = (process.env.SUPABASE_URL || "http://127.0.0.1:54321").replace(
  /\/$/,
  "",
);
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SERVICE_KEY || !ANON_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const pdfArg = process.argv[2];
const pdfPath = resolve(
  pdfArg ||
    resolve(root, "tmp-invoice/billing_data_1_.pdf"),
);
if (!existsSync(pdfPath)) {
  console.error(`PDF not found: ${pdfPath}`);
  console.error("Pass a path: node scripts/inbound-email-accuracy.mjs ./invoice.pdf");
  process.exit(1);
}

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`REST ${path} → ${res.status}: ${text}`);
  }
  return body;
}

const companies = await rest(
  "company_config?company_id=eq.00000000-0000-4000-8000-000000000001&select=company_id,inbound_email,company_slug",
);
const company = companies?.[0];
if (!company?.inbound_email) {
  console.error(
    "POC company has no inbound_email — run: npx supabase db reset (or migration up)",
  );
  process.exit(1);
}

console.log("Inbound address:", company.inbound_email);
console.log("Attachment:", pdfPath);

const form = new FormData();
form.append("recipient", company.inbound_email);
form.append("sender", "vendor@example.com");
form.append("from", "Vendor Bills <vendor@example.com>");
form.append("subject", "Invoice attached — inbound accuracy check");
form.append("attachment-count", "1");
form.append("timestamp", String(Math.floor(Date.now() / 1000)));
form.append("token", "local-test-token");
form.append("signature", "skipped");
const blob = new Blob([readFileSync(pdfPath)], { type: "application/pdf" });
form.append("attachment-1", blob, basename(pdfPath));

const webhookRes = await fetch(`${SUPABASE_URL}/functions/v1/inbound-email`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${ANON_KEY}`,
    apikey: ANON_KEY,
  },
  body: form,
});
const webhookText = await webhookRes.text();
let webhookBody;
try {
  webhookBody = JSON.parse(webhookText);
} catch {
  webhookBody = { raw: webhookText };
}
console.log("Webhook status:", webhookRes.status);
console.log("Webhook body:", JSON.stringify(webhookBody, null, 2));

if (!webhookRes.ok || webhookBody.ok === false) {
  console.error("FAIL: inbound-email webhook did not succeed");
  process.exit(1);
}

const documentId = webhookBody.documents?.[0]?.document_id;
if (!documentId) {
  console.error("FAIL: no document_id returned");
  process.exit(1);
}

const docs = await rest(
  `documents?id=eq.${documentId}&select=id,source,file_url,status,doc_type,company_id,uploaded_at,has_supporting_document`,
);
const doc = docs?.[0];
if (!doc) {
  console.error("FAIL: document row missing");
  process.exit(1);
}

const uploadShaped = {
  has_id: typeof doc.id === "string",
  source_is_email: doc.source === "email",
  has_file_url: typeof doc.file_url === "string" && doc.file_url.includes("/invoices/"),
  doc_type_invoice: doc.doc_type === "invoice",
  company_id_ok: doc.company_id === company.company_id,
  has_supporting_document: doc.has_supporting_document === true,
  status_past_upload: doc.status !== "pending" && doc.status !== "uploaded",
};

console.log("Document row:", doc);
console.log("Shape checks:", uploadShaped);

const allOk = Object.values(uploadShaped).every(Boolean);
if (!allOk) {
  console.error("FAIL: document shape does not match upload pipeline expectations");
  process.exit(1);
}

console.log(
  "\nPASS: inbound email → same ingest path; document is in the queue with upload-equivalent shape (source=email).",
);
console.log(`Open the review UI and select document ${documentId}`);
