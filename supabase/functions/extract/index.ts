// Extract structured fields from triaged invoices via Mindee OCR,
// with per-field vision-LLM fallback when confidence < 0.85.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const CONFIDENCE_THRESHOLD = 0.85;
const MINDEE_INVOICE_URL =
  "https://api.mindee.net/v1/products/mindee/invoices/v4/predict";

type ExtractableField = "vendor_raw" | "total_amount" | "invoice_date";

interface ExtractInput {
  document_id: string;
}

interface FieldValue {
  value: string | number | null;
  confidence: number;
  source: "mindee" | "llm" | "none";
}

interface ExtractionResult {
  vendor_raw: FieldValue;
  total_amount: FieldValue;
  invoice_date: FieldValue;
  raw_ocr_json: unknown;
  ai_fallback_used: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getSupabase(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function asDateString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  // Accept YYYY-MM-DD or parseable date strings → YYYY-MM-DD
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function mindeeField(
  prediction: Record<string, unknown>,
  key: string,
): { value: unknown; confidence: number } {
  const field = prediction[key] as
    | { value?: unknown; confidence?: number }
    | undefined;
  return {
    value: field?.value ?? null,
    confidence: typeof field?.confidence === "number" ? field.confidence : 0,
  };
}

async function callMindeeInvoice(
  fileUrl: string,
): Promise<{ prediction: Record<string, unknown>; raw: unknown }> {
  const apiKey = Deno.env.get("MINDEE_API_KEY");
  if (!apiKey) throw new Error("MINDEE_API_KEY is not set");

  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`Failed to fetch document file (${fileRes.status})`);
  }

  const bytes = new Uint8Array(await fileRes.arrayBuffer());
  const contentType = fileRes.headers.get("content-type") ?? "application/pdf";
  const filename =
    fileUrl.split("/").pop()?.split("?")[0] || "document.pdf";

  const form = new FormData();
  form.append(
    "document",
    new Blob([bytes], { type: contentType }),
    filename,
  );

  const res = await fetch(MINDEE_INVOICE_URL, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}` },
    body: form,
  });

  const raw = await res.json();
  if (!res.ok) {
    throw new Error(
      `Mindee Invoice API failed (${res.status}): ${JSON.stringify(raw)}`,
    );
  }

  const prediction =
    (raw?.document?.inference?.prediction as Record<string, unknown>) ?? {};
  return { prediction, raw };
}

function mapMindeeToFields(
  prediction: Record<string, unknown>,
): Pick<ExtractionResult, "vendor_raw" | "total_amount" | "invoice_date"> {
  const supplier = mindeeField(prediction, "supplier_name");
  const total = mindeeField(prediction, "total_amount");
  const date = mindeeField(prediction, "date");

  return {
    vendor_raw: {
      value: supplier.value != null ? String(supplier.value) : null,
      confidence: supplier.confidence,
      source: "mindee",
    },
    total_amount: {
      value: asNumber(total.value),
      confidence: total.confidence,
      source: "mindee",
    },
    invoice_date: {
      value: asDateString(date.value),
      confidence: date.confidence,
      source: "mindee",
    },
  };
}

async function reExtractFieldWithVisionLlm(
  fileUrl: string,
  field: ExtractableField,
): Promise<FieldValue> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  const baseUrl = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
  const model = Deno.env.get("EXTRACT_LLM_MODEL") ?? "gpt-4o";

  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const fieldInstructions: Record<ExtractableField, string> = {
    vendor_raw:
      'Extract only the vendor / supplier name. JSON: {"value": string|null, "confidence": 0-1}',
    total_amount:
      'Extract only the invoice total amount as a number. JSON: {"value": number|null, "confidence": 0-1}',
    invoice_date:
      'Extract only the invoice date as YYYY-MM-DD. JSON: {"value": string|null, "confidence": 0-1}',
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You extract a single invoice field from the document image. Return strict JSON only. Do not extract any other fields.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: fieldInstructions[field] },
            { type: "image_url", image_url: { url: fileUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vision LLM fallback failed for ${field} (${res.status}): ${errText}`);
  }

  const payload = await res.json();
  const content = payload?.choices?.[0]?.message?.content ?? "{}";
  let parsed: { value?: unknown; confidence?: number };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Vision LLM returned non-JSON for ${field}: ${content}`);
  }

  const confidence = Math.max(
    0,
    Math.min(1, Number(parsed.confidence ?? 0.5)),
  );

  if (field === "total_amount") {
    return {
      value: asNumber(parsed.value),
      confidence,
      source: "llm",
    };
  }
  if (field === "invoice_date") {
    return {
      value: asDateString(parsed.value),
      confidence,
      source: "llm",
    };
  }
  return {
    value: parsed.value != null ? String(parsed.value) : null,
    confidence,
    source: "llm",
  };
}

async function applyFieldFallbacks(
  fileUrl: string,
  fields: Pick<ExtractionResult, "vendor_raw" | "total_amount" | "invoice_date">,
): Promise<ExtractionResult> {
  let aiFallbackUsed = false;
  const result = { ...fields } as ExtractionResult;
  result.raw_ocr_json = null;
  result.ai_fallback_used = false;

  const targets: ExtractableField[] = [
    "vendor_raw",
    "total_amount",
    "invoice_date",
  ];

  for (const field of targets) {
    const current = result[field];
    if (current.confidence >= CONFIDENCE_THRESHOLD) continue;

    try {
      console.log(
        `Low confidence on ${field} (${current.confidence}); running vision LLM fallback`,
      );
      const replaced = await reExtractFieldWithVisionLlm(fileUrl, field);
      result[field] = replaced;
      aiFallbackUsed = true;
    } catch (err) {
      // Per-field failure must not abort the whole extraction.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`AI fallback failed for ${field}:`, message);
    }
  }

  result.ai_fallback_used = aiFallbackUsed;
  return result;
}

async function persistExtraction(
  supabase: SupabaseClient,
  documentId: string,
  extraction: ExtractionResult,
): Promise<string> {
  const confidenceScores = {
    vendor_raw: extraction.vendor_raw.confidence,
    total_amount: extraction.total_amount.confidence,
    invoice_date: extraction.invoice_date.confidence,
    sources: {
      vendor_raw: extraction.vendor_raw.source,
      total_amount: extraction.total_amount.source,
      invoice_date: extraction.invoice_date.source,
    },
  };

  const row = {
    document_id: documentId,
    doc_type: "invoice",
    vendor_raw: extraction.vendor_raw.value != null
      ? String(extraction.vendor_raw.value)
      : null,
    total_amount: asNumber(extraction.total_amount.value),
    invoice_date: asDateString(extraction.invoice_date.value),
    confidence_scores: confidenceScores,
    raw_ocr_json: extraction.raw_ocr_json,
    ai_fallback_used: extraction.ai_fallback_used,
  };

  const { data, error } = await supabase
    .from("extracted_fields")
    .insert(row)
    .select("id")
    .single();

  if (error) throw new Error(`extracted_fields insert failed: ${error.message}`);
  return data.id as string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let input: ExtractInput;
  try {
    input = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!input?.document_id) {
    return jsonResponse({ error: "document_id is required" }, 400);
  }

  const warnings: string[] = [];

  try {
    const supabase = getSupabase();

    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("id, file_url, doc_type, status")
      .eq("id", input.document_id)
      .single();

    if (docError || !doc) {
      return jsonResponse(
        { error: `Document not found: ${docError?.message ?? input.document_id}` },
        404,
      );
    }

    if (doc.doc_type !== "invoice") {
      // Not an error — pipeline continues; this step only handles invoices.
      console.log(
        `Skipping extract for document ${doc.id}: doc_type=${doc.doc_type}`,
      );
      return jsonResponse({
        document_id: doc.id,
        skipped: true,
        reason: `extract only runs for doc_type=invoice (got ${doc.doc_type})`,
      });
    }

    let prediction: Record<string, unknown> = {};
    let rawOcr: unknown = null;

    try {
      const mindee = await callMindeeInvoice(doc.file_url);
      prediction = mindee.prediction;
      rawOcr = mindee.raw;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Mindee extraction failed:", message);
      warnings.push(`mindee: ${message}`);

      await supabase
        .from("documents")
        .update({ status: "extraction_failed" })
        .eq("id", doc.id);

      // Log failure without crashing — return a controlled response.
      return jsonResponse({
        document_id: doc.id,
        ok: false,
        error: message,
        warnings,
      }, 200);
    }

    let fields = mapMindeeToFields(prediction);
    let extraction: ExtractionResult;

    try {
      extraction = await applyFieldFallbacks(doc.file_url, fields);
      extraction.raw_ocr_json = rawOcr;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Field fallback stage failed:", message);
      warnings.push(`fallback: ${message}`);
      extraction = {
        ...fields,
        raw_ocr_json: rawOcr,
        ai_fallback_used: false,
      };
    }

    try {
      const extractedId = await persistExtraction(supabase, doc.id, extraction);
      await supabase
        .from("documents")
        .update({ status: "extracted" })
        .eq("id", doc.id);

      return jsonResponse({
        document_id: doc.id,
        extracted_fields_id: extractedId,
        ok: true,
        ai_fallback_used: extraction.ai_fallback_used,
        confidence_scores: {
          vendor_raw: extraction.vendor_raw.confidence,
          total_amount: extraction.total_amount.confidence,
          invoice_date: extraction.invoice_date.confidence,
        },
        fields: {
          vendor_raw: extraction.vendor_raw.value,
          total_amount: extraction.total_amount.value,
          invoice_date: extraction.invoice_date.value,
        },
        warnings,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Persist extraction failed:", message);
      warnings.push(`persist: ${message}`);

      await supabase
        .from("documents")
        .update({ status: "extraction_failed" })
        .eq("id", doc.id);

      return jsonResponse({
        document_id: doc.id,
        ok: false,
        error: message,
        warnings,
      }, 200);
    }
  } catch (err) {
    // Outer guard: never let an unexpected throw become an unhandled crash.
    const message = err instanceof Error ? err.message : String(err);
    console.error("extract pipeline error:", message);
    return jsonResponse({ ok: false, error: message, warnings }, 200);
  }
});
