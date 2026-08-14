/**
 * Upload a sample invoice PDF, insert documents row, call extract, print field_report.
 * Usage: node scripts/e2e-extract-accuracy.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(path) {
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
      ) {
        v = v.slice(1, -1);
      }
      out[t.slice(0, i)] = v;
    }
  } catch {
    /* missing ok */
  }
  return out;
}

function buildInvoicePdf() {
  const lines = [
    "BT /F1 18 Tf 72 720 Td (ACME Supplies Pvt Ltd) Tj ET",
    "BT /F1 14 Tf 72 690 Td (TAX INVOICE #INV-1042) Tj ET",
    "BT /F1 12 Tf 72 660 Td (Bill To: Contoso LLC) Tj ET",
    "BT /F1 12 Tf 72 630 Td (Invoice Date: 01 Aug 2026) Tj ET",
    "BT /F1 12 Tf 72 600 Td (Total Amount Due: USD 1240.00) Tj ET",
    "BT /F1 12 Tf 72 570 Td (Vendor GSTIN: 29ABCDE1234F1Z5) Tj ET",
  ];
  const stream = lines.join("\n") + "\n";
  const objs = [];
  objs.push("1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n");
  objs.push("2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n");
  objs.push(
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n",
  );
  objs.push(
    `4 0 obj<< /Length ${stream.length} >>stream\n${stream}endstream\nendobj\n`,
  );
  objs.push(
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  );
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += o;
  }
  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objs.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

const projectEnv = loadEnvFile(resolve(root, ".env"));
const statusEnv = loadEnvFile(resolve(root, "tmp-supabase.env"));
const supabaseUrl = statusEnv.API_URL || projectEnv.SUPABASE_URL ||
  "http://127.0.0.1:54321";
const serviceKey = statusEnv.SERVICE_ROLE_KEY ||
  projectEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) {
  console.error("SERVICE_ROLE_KEY missing");
  process.exit(1);
}

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
};

const pdf = buildInvoicePdf();
const objectPath = `accuracy/${Date.now()}-acme-invoice-1042.pdf`;

const uploadRes = await fetch(
  `${supabaseUrl}/storage/v1/object/invoices/${objectPath}`,
  {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: pdf,
  },
);
if (!uploadRes.ok) {
  console.error("Upload failed", uploadRes.status, await uploadRes.text());
  process.exit(1);
}

const fileUrl =
  `${supabaseUrl}/storage/v1/object/public/invoices/${objectPath}`;

const docRes = await fetch(`${supabaseUrl}/rest/v1/documents`, {
  method: "POST",
  headers: {
    ...headers,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  },
  body: JSON.stringify({
    source: "accuracy_check",
    file_url: fileUrl,
    status: "triaged",
    doc_type: "invoice",
    confidence: 0.95,
  }),
});
if (!docRes.ok) {
  console.error("Insert document failed", docRes.status, await docRes.text());
  process.exit(1);
}
const [doc] = await docRes.json();
console.log(JSON.stringify({ uploaded: true, document_id: doc.id, fileUrl }, null, 2));

const extractUrl = `${supabaseUrl}/functions/v1/extract`;
const extractRes = await fetch(extractUrl, {
  method: "POST",
  headers: {
    ...headers,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ document_id: doc.id }),
});
const extractBody = await extractRes.json();
console.log(
  JSON.stringify(
    {
      extract_http_status: extractRes.status,
      extract_response: extractBody,
    },
    null,
    2,
  ),
);

if (!extractRes.ok || extractBody.ok === false) process.exit(1);
