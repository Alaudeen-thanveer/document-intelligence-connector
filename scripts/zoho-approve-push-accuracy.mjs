/**
 * Accuracy: human-approve path → Zoho sandbox bill + attachment.
 * Mirrors ReviewPanel approve (status=approved, judgments passed, then zoho-push).
 *
 *   node scripts/zoho-approve-push-accuracy.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
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

function buildInvoicePdf() {
  const lines = [
    "BT /F1 18 Tf 72 720 Td (Sandbox Push Vendor LLC) Tj ET",
    "BT /F1 14 Tf 72 690 Td (INVOICE #ZOHO-ACC-1) Tj ET",
    "BT /F1 12 Tf 72 660 Td (Total Due: 42.00) Tj ET",
    "BT /F1 12 Tf 72 630 Td (Invoice Date: 2026-08-12) Tj ET",
  ];
  const stream = lines.join("\n") + "\n";
  const objs = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n",
    `4 0 obj<< /Length ${stream.length} >>stream\n${stream}endstream\nendobj\n`,
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += o;
  }
  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

const statusEnv = loadEnv(resolve(root, "tmp-supabase.env"));
const env = { ...statusEnv, ...loadEnv(resolve(root, ".env")) };
const supabaseUrl = env.API_URL || env.SUPABASE_URL || "http://127.0.0.1:54321";
const serviceKey = env.SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

const required = [
  "ZOHO_CLIENT_ID",
  "ZOHO_CLIENT_SECRET",
  "ZOHO_REFRESH_TOKEN",
  "ZOHO_ORGANIZATION_ID",
];
const missing = required.filter((k) => !env[k]?.trim());
if (!serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
if (missing.length) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        blocked: true,
        error: "Missing env for Zoho sandbox accuracy check",
        missing,
        fill: ".env (Zoho sandbox OAuth + organization id), then restart functions serve",
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

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
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  return body;
}

const pdf = buildInvoicePdf();
const objectPath = `accuracy/zoho-${Date.now()}.pdf`;
const up = await fetch(
  `${supabaseUrl}/storage/v1/object/invoices/${objectPath}`,
  {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: pdf,
  },
);
if (!up.ok) {
  console.error("upload failed", await up.text());
  process.exit(1);
}
const fileUrl =
  `${supabaseUrl}/storage/v1/object/public/invoices/${objectPath}`;

const [doc] = await rest("/rest/v1/documents", {
  method: "POST",
  body: JSON.stringify({
    source: "zoho_accuracy",
    file_url: fileUrl,
    status: "needs_review",
    doc_type: "invoice",
    has_supporting_document: true,
  }),
});

await rest("/rest/v1/extracted_fields", {
  method: "POST",
  body: JSON.stringify({
    document_id: doc.id,
    doc_type: "invoice",
    vendor_raw: "Sandbox Push Vendor LLC",
    total_amount: 42,
    invoice_date: "2026-08-12",
    po_number: "PO-ZOHO-1",
    ai_fallback_used: false,
  }),
});

// Clean pass judgments (as if checks already passed / human cleared them)
for (const rule_name of [
  "duplicate_vendor_amount_date",
  "missing_supporting_document",
  "amount_above_threshold_no_po",
  "human_review_approval",
]) {
  await rest("/rest/v1/judgment_results", {
    method: "POST",
    body: JSON.stringify({
      document_id: doc.id,
      rule_name,
      passed: true,
      notes: "Accuracy seed — approved for Zoho sandbox push",
      reviewed_by: "accuracy_script",
    }),
  });
}

// Human approve (same status ReviewPanel sets before calling zoho-push)
await rest(`/rest/v1/documents?id=eq.${doc.id}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "approved" }),
});

const pushRes = await fetch(`${supabaseUrl}/functions/v1/zoho-push`, {
  method: "POST",
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    document_id: doc.id,
    expense_category: env.ZOHO_EXPENSE_CATEGORY || "Miscellaneous",
  }),
});
const pushBody = await pushRes.json();

const outPath = resolve(root, "tmp-zoho-push-accuracy.json");
writeFileSync(outPath, JSON.stringify({ document_id: doc.id, push: pushBody }, null, 2));

console.log(
  JSON.stringify(
    {
      ok: Boolean(pushRes.ok && pushBody.ok),
      document_id: doc.id,
      http_status: pushRes.status,
      external_doc_id: pushBody.external_doc_id ?? null,
      attachment_present: pushBody.attachment?.present_on_bill ?? false,
      attachment_filename: pushBody.attachment?.filename ?? null,
      sandbox_organization_id: pushBody.sandbox_organization_id ??
        env.ZOHO_ORGANIZATION_ID,
      error: pushBody.error ?? pushBody.reason ?? null,
      evidence_file: outPath,
      zoho_bill_summary: pushBody.zoho_bill?.bill
        ? {
          bill_id: pushBody.zoho_bill.bill.bill_id,
          vendor_id: pushBody.zoho_bill.bill.vendor_id,
          total: pushBody.zoho_bill.bill.total,
          attachment_name: pushBody.zoho_bill.bill.attachment_name,
          documents: pushBody.zoho_bill.bill.documents,
        }
        : pushBody.zoho_bill ?? null,
    },
    null,
    2,
  ),
);

process.exit(pushRes.ok && pushBody.ok && pushBody.attachment?.present_on_bill
  ? 0
  : 1);
