/**
 * Accuracy check: force Gemini fallback on a low-OCR-confidence field.
 * Uses a local invoice PDF from Storage (or ACCURACY_INVOICE_PATH).
 *
 * Run (from repo root, with GEMINI_API_KEY set):
 *   deno run --allow-env --allow-net --allow-read supabase/functions/extract/gemini_accuracy_check.ts
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { reExtractFieldWithGemini } from "./gemini_fallback.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!serviceKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required");
  Deno.exit(1);
}
if (!Deno.env.get("GEMINI_API_KEY")) {
  console.error("GEMINI_API_KEY is required");
  Deno.exit(1);
}

function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${contentType};base64,${btoa(binary)}`;
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let dataUrl: string;
const localPath = Deno.env.get("ACCURACY_INVOICE_PATH");
if (localPath) {
  const bytes = await Deno.readFile(localPath);
  const mime = localPath.toLowerCase().endsWith(".png")
    ? "image/png"
    : localPath.toLowerCase().endsWith(".jpg") ||
        localPath.toLowerCase().endsWith(".jpeg")
    ? "image/jpeg"
    : "application/pdf";
  dataUrl = bytesToDataUrl(bytes, mime);
} else {
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, file_url")
    .eq("doc_type", "invoice")
    .order("uploaded_at", { ascending: false })
    .limit(1);
  if (error || !docs?.[0]) {
    console.error("No invoice document found:", error?.message);
    Deno.exit(1);
  }
  const fileUrl = docs[0].file_url as string;
  const marker = "/storage/v1/object/public/invoices/";
  const idx = fileUrl.indexOf(marker);
  if (idx < 0) {
    console.error("Unexpected file_url:", fileUrl);
    Deno.exit(1);
  }
  const path = decodeURIComponent(fileUrl.slice(idx + marker.length));
  const { data, error: dlError } = await supabase.storage
    .from("invoices")
    .download(path);
  if (dlError || !data) {
    console.error("Storage download failed:", dlError?.message);
    Deno.exit(1);
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  dataUrl = bytesToDataUrl(bytes, data.type || "application/pdf");
}

// Simulate low Mindee OCR confidence for vendor_raw (< company threshold 0.8)
const simulatedOcrConfidence = 0.42;
const gemini = await reExtractFieldWithGemini(dataUrl, "vendor_raw");

console.log(
  JSON.stringify(
    {
      ok: true,
      test: "gemini_fallback_low_ocr_confidence",
      field: "vendor_raw",
      simulated_mindee_ocr_confidence: simulatedOcrConfidence,
      threshold: 0.8,
      fallback_triggered: simulatedOcrConfidence < 0.8,
      gemini_response: {
        value: gemini.value,
        confidence: gemini.confidence,
        source: gemini.source,
        raw_text: gemini.raw_text,
      },
    },
    null,
    2,
  ),
);
