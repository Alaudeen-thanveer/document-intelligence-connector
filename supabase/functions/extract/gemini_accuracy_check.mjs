/**
 * Accuracy check: simulate low Mindee OCR confidence, call Gemini Flash for vendor_raw.
 * Mirrors supabase/functions/extract/gemini_fallback.ts prompt + JSON validation.
 *
 * Run from repo root:
 *   node supabase/functions/extract/gemini_accuracy_check.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../../..");

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

function buildInvoicePdf() {
  // Minimal one-page PDF with invoice-like text (Helvetica).
  const lines = [
    "BT /F1 18 Tf 72 720 Td (ACME Supplies) Tj ET",
    "BT /F1 14 Tf 72 690 Td (INVOICE #1042) Tj ET",
    "BT /F1 12 Tf 72 660 Td (Bill To: Contoso LLC) Tj ET",
    "BT /F1 12 Tf 72 630 Td (Total Due: $1,240.00) Tj ET",
    "BT /F1 12 Tf 72 600 Td (Invoice Date: 2026-08-01) Tj ET",
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

function extractJsonObject(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error(`Gemini returned non-JSON: ${trimmed}`);
  }
}

const env = loadEnv(resolve(root, ".env"));
const apiKey = env.GEMINI_API_KEY?.trim();
const model = (env.GEMINI_MODEL?.trim() || "gemini-3.6-flash");
if (!apiKey) {
  console.error("GEMINI_API_KEY is empty in .env");
  process.exit(1);
}
if (model.includes("2.5")) {
  console.error(`GEMINI_MODEL=${model} not allowed (2.5 line)`);
  process.exit(1);
}

const pdfPath = resolve(root, "tmp-accuracy-invoice.pdf");
writeFileSync(pdfPath, buildInvoicePdf());
const base64 = readFileSync(pdfPath).toString("base64");
try {
  unlinkSync(pdfPath);
} catch {
  /* ignore */
}

const prompt = [
  "You extract a single invoice field from the attached document.",
  "Gemini does not provide a native confidence score — you MUST self-report confidence.",
  'Respond with parseable JSON only, shape: {"value": ..., "confidence": 0-1}.',
  "Do not extract any other fields. No markdown.",
  'Extract only the vendor / supplier name. Return JSON only: {"value": string|null, "confidence": number between 0 and 1}',
].join(" ");

const url =
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inline_data: { mime_type: "application/pdf", data: base64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  }),
});

const body = await res.json();
if (!res.ok) {
  console.error(JSON.stringify({ ok: false, http_status: res.status, body }, null, 2));
  process.exit(1);
}

const rawText =
  body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
let parsed;
try {
  parsed = extractJsonObject(rawText);
} catch (err) {
  console.error(
    JSON.stringify(
      { ok: false, error: String(err), raw_text: rawText },
      null,
      2,
    ),
  );
  process.exit(1);
}

if (
  typeof parsed !== "object" ||
  parsed === null ||
  !("value" in parsed) ||
  !("confidence" in parsed) ||
  !Number.isFinite(Number(parsed.confidence))
) {
  console.error(
    JSON.stringify(
      { ok: false, error: "invalid JSON shape", parsed, raw_text: rawText },
      null,
      2,
    ),
  );
  process.exit(1);
}

const simulatedOcrConfidence = 0.42;
const threshold = 0.8;

console.log(
  JSON.stringify(
    {
      ok: true,
      test: "gemini_fallback_low_ocr_confidence",
      field: "vendor_raw",
      model,
      simulated_mindee_ocr_confidence: simulatedOcrConfidence,
      threshold,
      fallback_triggered: simulatedOcrConfidence < threshold,
      gemini_response: {
        value: parsed.value != null ? String(parsed.value) : null,
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence))),
        source: "gemini",
        raw_text: rawText,
      },
    },
    null,
    2,
  ),
);
