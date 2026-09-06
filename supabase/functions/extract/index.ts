// Extract structured fields from triaged invoices via Mindee OCR,
// with per-field vision-LLM fallback when OCR confidence is below the
// per-company extraction_confidence_threshold (default 0.8).
//
// Secrets (never hardcoded): MINDEE_API_KEY, GEMINI_API_KEY
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { blobPart } from "../_shared/bytes.ts";
import {
  extractLineItemsWithGemini,
  reExtractFieldWithGemini,
} from "./gemini_fallback.ts";
import { isAuthFail, requireAuth } from "../_shared/require_user.ts";
import { companyForCaller, isCompanyFail } from "../_shared/tenant.ts";

const DEFAULT_EXTRACTION_CONFIDENCE_THRESHOLD = 0.8;
const MINDEE_V1_INVOICE_URL =
  "https://api.mindee.net/v1/products/mindee/invoices/v4/predict";
const MINDEE_V2_ENQUEUE_URL = "https://api-v2.mindee.net/v2/inferences/enqueue";
const MINDEE_V2_JOB_URL = "https://api-v2.mindee.net/v2/jobs";

type ExtractableField = "vendor_raw" | "total_amount" | "invoice_date";
/** Fields that fall back to Gemini only when OCR found no value at all —
 * they skip the confidence threshold so they add no cost when OCR reads them. */
type PresenceField = "currency" | "tax_amount" | "invoice_number" | "due_date" | "customer_raw" | "po_number";

interface ExtractedLine {
  description: string | null;
  quantity: number;
  rate: number | null;
  amount: number | null;
  source: "ocr" | "gemini";
}

interface ExtractInput {
  document_id: string;
}

interface FieldValue {
  value: string | number | null;
  confidence: number;
  source: "mindee" | "gemini" | "none";
  /** OCR confidence before any vision-LLM fallback. */
  ocr_confidence?: number;
  /** True when this field was re-extracted via Gemini. */
  ai_fallback_triggered?: boolean;
  /** Raw Gemini JSON text when fallback ran (for accuracy checks). */
  gemini_raw?: string;
}

interface ExtractionResult {
  vendor_raw: FieldValue;
  total_amount: FieldValue;
  invoice_date: FieldValue;
  currency: FieldValue;
  tax_amount: FieldValue;
  invoice_number: FieldValue;
  due_date: FieldValue;
  customer_raw: FieldValue;
  po_number: FieldValue;
  line_items: ExtractedLine[];
  raw_ocr_json: unknown;
  ai_fallback_used: boolean;
  threshold_used: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
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

/**
 * Read a Mindee field. Confidence is `null` when the API omitted a score
 * (Mindee v2 returns confidence: null on every field). Callers must not treat
 * null as 0 — that forced Gemini fallback on every field (issue #2).
 */
function mindeeField(
  prediction: Record<string, unknown>,
  key: string,
): { value: unknown; confidence: number | null } {
  const field = prediction[key] as
    | { value?: unknown; confidence?: number | null }
    | undefined;
  return {
    value: field?.value ?? null,
    confidence: typeof field?.confidence === "number" ? field.confidence : null,
  };
}

/**
 * Map OCR confidence for threshold routing.
 * - Missing/unparseable value → 0 (always eligible for Gemini)
 * - Real numeric score from Mindee (v1) → use as-is
 * - Value present but score omitted (v2) → trust OCR (1); only fall back when empty
 */
function resolveOcrConfidence(
  normalizedValue: unknown,
  rawConfidence: number | null,
): number {
  if (normalizedValue == null || normalizedValue === "") return 0;
  if (typeof rawConfidence === "number") return rawConfidence;
  return 1;
}

/** Load invoice bytes; prefer Storage client so Docker-local 127.0.0.1 URLs work. */
async function loadDocumentBytes(
  supabase: SupabaseClient,
  fileUrl: string,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  const markers = [
    "/storage/v1/object/public/invoices/",
    "/storage/v1/object/sign/invoices/",
    "/storage/v1/object/authenticated/invoices/",
    "storage://invoices/",
  ];
  let path: string | null = null;
  for (const marker of markers) {
    const idx = fileUrl.indexOf(marker);
    if (idx >= 0) {
      path = decodeURIComponent(fileUrl.slice(idx + marker.length).split("?")[0]);
      break;
    }
  }
  if (!path && !fileUrl.includes("://") && fileUrl.includes("/")) {
    path = fileUrl.split("?")[0];
  }

  if (path) {
    const { data, error } = await supabase.storage.from("invoices").download(path);
    if (error || !data) {
      throw new Error(`storage download failed: ${error?.message ?? "no data"}`);
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    return {
      bytes,
      contentType: data.type || "application/pdf",
      filename: path.split("/").pop() || "document.pdf",
    };
  }

  // Rewrite host loopback for functions running inside Docker.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
  const fetchable = fileUrl
    .replace("http://127.0.0.1:54321", supabaseUrl)
    .replace("http://localhost:54321", supabaseUrl);

  const fileRes = await fetch(fetchable);
  if (!fileRes.ok) {
    throw new Error(`Failed to fetch document file (${fileRes.status})`);
  }
  const bytes = new Uint8Array(await fileRes.arrayBuffer());
  return {
    bytes,
    contentType: fileRes.headers.get("content-type") ?? "application/pdf",
    filename: fileUrl.split("/").pop()?.split("?")[0] || "document.pdf",
  };
}

function pickField(
  prediction: Record<string, unknown>,
  keys: string[],
): { value: unknown; confidence: number | null } {
  for (const key of keys) {
    const field = mindeeField(prediction, key);
    if (field.value != null && field.value !== "") return field;
  }
  // return first key's confidence even if null, for threshold routing
  return mindeeField(prediction, keys[0] ?? "unknown");
}

/** Normalize Mindee v2 inference payloads into a flat prediction map. */
function normalizeMindeePrediction(raw: unknown): Record<string, unknown> {
  const root = raw as Record<string, unknown>;
  const inference = (root?.inference ?? root) as Record<string, unknown>;
  const result = (inference?.result ?? inference?.document ?? root) as Record<
    string,
    unknown
  >;
  const fields = (result?.fields ?? result?.prediction ?? result) as Record<
    string,
    unknown
  >;
  if (fields && typeof fields === "object") return fields;
  return {};
}

async function callMindeeV1(
  apiKey: string,
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): Promise<{ prediction: Record<string, unknown>; raw: unknown }> {
  const form = new FormData();
  form.append("document", new Blob([blobPart(bytes)], { type: contentType }), filename);

  const res = await fetch(MINDEE_V1_INVOICE_URL, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}` },
    body: form,
  });
  const raw = await res.json();
  if (!res.ok) {
    throw new Error(
      `Mindee Invoice API v1 failed (${res.status}): ${JSON.stringify(raw)}`,
    );
  }
  const prediction =
    (raw?.document?.inference?.prediction as Record<string, unknown>) ?? {};
  return { prediction, raw };
}

async function callMindeeV2(
  apiKey: string,
  modelId: string,
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): Promise<{ prediction: Record<string, unknown>; raw: unknown }> {
  const form = new FormData();
  form.append("model_id", modelId);
  form.append("file", new Blob([blobPart(bytes)], { type: contentType }), filename);

  // V2 keys are not JWTs — Authorization must be the raw API key only (no Token/Bearer).
  const enqueueRes = await fetch(MINDEE_V2_ENQUEUE_URL, {
    method: "POST",
    headers: { Authorization: apiKey },
    body: form,
  });
  const enqueueRaw = await enqueueRes.json();
  if (!enqueueRes.ok) {
    throw new Error(
      `Mindee v2 enqueue failed (${enqueueRes.status}): ${JSON.stringify(enqueueRaw)}`,
    );
  }

  const jobId =
    enqueueRaw?.job?.id ??
    enqueueRaw?.id ??
    enqueueRaw?.job_id;
  if (!jobId) {
    throw new Error(
      `Mindee v2 enqueue returned no job id: ${JSON.stringify(enqueueRaw)}`,
    );
  }

  let raw: unknown = enqueueRaw;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    const jobRes = await fetch(`${MINDEE_V2_JOB_URL}/${jobId}`, {
      headers: { Authorization: apiKey },
      redirect: "follow",
    });
    raw = await jobRes.json();
    if (!jobRes.ok) {
      throw new Error(
        `Mindee v2 job poll failed (${jobRes.status}): ${JSON.stringify(raw)}`,
      );
    }

    const status =
      (raw as { job?: { status?: string }; status?: string })?.job?.status ??
      (raw as { status?: string })?.status;

    if (status === "failed" || status === "error") {
      throw new Error(`Mindee v2 job failed: ${JSON.stringify(raw)}`);
    }

    const inference =
      (raw as { inference?: unknown })?.inference ??
      (raw as { job?: { inference?: unknown } })?.job?.inference;
    if (inference || status === "completed" || status === "processed") {
      const prediction = normalizeMindeePrediction(raw);
      if (Object.keys(prediction).length > 0 || inference) {
        return {
          prediction: Object.keys(prediction).length > 0
            ? prediction
            : normalizeMindeePrediction({ inference }),
          raw,
        };
      }
    }
  }

  throw new Error(`Mindee v2 polling timed out for job ${jobId}`);
}

async function callMindeeInvoice(
  supabase: SupabaseClient,
  fileUrl: string,
): Promise<{ prediction: Record<string, unknown>; raw: unknown }> {
  const apiKey = Deno.env.get("MINDEE_API_KEY");
  if (!apiKey) throw new Error("MINDEE_API_KEY is not set");

  const { bytes, contentType, filename } = await loadDocumentBytes(
    supabase,
    fileUrl,
  );

  const modelId = Deno.env.get("MINDEE_MODEL_ID")?.trim();
  if (modelId) {
    return await callMindeeV2(apiKey, modelId, bytes, contentType, filename);
  }

  try {
    return await callMindeeV1(apiKey, bytes, contentType, filename);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("token provided is for the v2 API")) {
      throw new Error(
        "MINDEE_API_KEY is a v2 key. Set MINDEE_MODEL_ID in .env (from your Mindee dashboard model) and retry.",
      );
    }
    throw err;
  }
}

/** Currency hides in nested shapes: v2 `locale.fields.currency.value`,
 * v1 `locale.value`/`locale.currency`, or a flat `currency` field. */
function mindeeCurrency(
  prediction: Record<string, unknown>,
): string | null {
  const flat = mindeeField(prediction, "currency").value;
  const locale = prediction.locale as
    | {
      value?: unknown;
      currency?: unknown;
      fields?: { currency?: { value?: unknown } };
    }
    | undefined;
  const candidate = flat ?? locale?.fields?.currency?.value ??
    locale?.currency ?? locale?.value;
  if (candidate == null) return null;
  const code = String(candidate).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** VAT amount: prefer `total_tax`; else sum the `taxes` line items
 * (v2 shape taxes.items[].fields.amount.value, v1 taxes[].value). */
function mindeeTaxAmount(
  prediction: Record<string, unknown>,
): number | null {
  const flat = asNumber(pickField(prediction, ["total_tax", "tax"]).value);
  if (flat != null) return flat;

  const taxes = prediction.taxes as
    | { items?: unknown[] }
    | unknown[]
    | undefined;
  const items = Array.isArray(taxes) ? taxes : taxes?.items;
  if (!Array.isArray(items) || items.length === 0) return null;

  let sum = 0;
  let found = false;
  for (const item of items) {
    const it = item as {
      value?: unknown;
      amount?: unknown;
      fields?: { amount?: { value?: unknown } };
    };
    const amount = asNumber(
      it.fields?.amount?.value ?? it.amount ?? it.value,
    );
    if (amount != null) {
      sum += amount;
      found = true;
    }
  }
  return found ? sum : null;
}

/** Line items across Mindee shapes: v1 `line_items[]` flat objects,
 * v2 `line_items.items[]` where values may nest under `fields`. */
function mindeeLineItems(
  prediction: Record<string, unknown>,
): ExtractedLine[] {
  const raw = prediction.line_items as
    | { items?: unknown[] }
    | unknown[]
    | undefined;
  const items = Array.isArray(raw) ? raw : raw?.items;
  if (!Array.isArray(items)) return [];

  const lines: ExtractedLine[] = [];
  for (const item of items) {
    const it = item as Record<string, unknown>;
    const f = (it.fields ?? it) as Record<string, unknown>;
    const get = (key: string): unknown => {
      const v = f[key];
      return v != null && typeof v === "object" && "value" in (v as object)
        ? (v as { value?: unknown }).value
        : v;
    };
    const description = get("description") != null
      ? String(get("description"))
      : null;
    const quantity = asNumber(get("quantity")) ?? 1;
    const rate = asNumber(get("unit_price")) ?? asNumber(get("rate"));
    const amount = asNumber(get("total_amount")) ?? asNumber(get("amount"));
    if (description || rate != null || amount != null) {
      lines.push({ description, quantity, rate, amount, source: "ocr" });
    }
  }
  return lines;
}

function mapMindeeToFields(
  prediction: Record<string, unknown>,
): Pick<
  ExtractionResult,
  | "vendor_raw"
  | "total_amount"
  | "invoice_date"
  | "currency"
  | "tax_amount"
  | "invoice_number"
  | "due_date"
  | "customer_raw"
  | "po_number"
  | "line_items"
> {
  const supplier = pickField(prediction, [
    "supplier_name",
    "vendor_name",
    "supplier",
    "vendor",
  ]);
  const total = pickField(prediction, [
    "total_amount",
    "total_incl",
    "total",
    "amount_due",
  ]);
  const date = pickField(prediction, [
    "date",
    "invoice_date",
    "document_date",
  ]);

  const vendorValue = supplier.value != null ? String(supplier.value) : null;
  const totalValue = asNumber(total.value);
  const dateValue = asDateString(date.value);

  return {
    vendor_raw: {
      value: vendorValue,
      confidence: resolveOcrConfidence(vendorValue, supplier.confidence),
      source: "mindee",
    },
    total_amount: {
      value: totalValue,
      confidence: resolveOcrConfidence(totalValue, total.confidence),
      source: "mindee",
    },
    invoice_date: {
      value: dateValue,
      confidence: resolveOcrConfidence(dateValue, date.confidence),
      source: "mindee",
    },
    currency: {
      value: mindeeCurrency(prediction),
      confidence: mindeeCurrency(prediction) != null ? 1 : 0,
      source: "mindee",
    },
    tax_amount: {
      value: mindeeTaxAmount(prediction),
      confidence: mindeeTaxAmount(prediction) != null ? 1 : 0,
      source: "mindee",
    },
    invoice_number: (() => {
      const v = pickField(prediction, [
        "invoice_number",
        "document_number",
        "bill_number",
      ]);
      const s = v.value != null ? String(v.value).trim() : null;
      return {
        value: s || null,
        confidence: s ? 1 : 0,
        source: "mindee" as const,
      };
    })(),
    due_date: (() => {
      const v = asDateString(pickField(prediction, ["due_date"]).value);
      return {
        value: v,
        confidence: v != null ? 1 : 0,
        source: "mindee" as const,
      };
    })(),
    customer_raw: (() => {
      const v = pickField(prediction, ["customer_name", "bill_to", "customer"]);
      const sv = v.value != null ? String(v.value).trim() : null;
      return { value: sv || null, confidence: sv ? 1 : 0, source: "mindee" as const };
    })(),
    po_number: (() => {
      const v = pickField(prediction, ["purchase_order_number", "po_number", "purchase_order", "order_number"]);
      const sv = v.value != null ? String(v.value).trim() : null;
      return { value: sv || null, confidence: sv ? 1 : 0, source: "mindee" as const };
    })(),
    line_items: mindeeLineItems(prediction),
  };
}

function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function loadExtractionThreshold(
  supabase: SupabaseClient,
  companyId: string | null | undefined,
): Promise<number> {
  if (!companyId) return DEFAULT_EXTRACTION_CONFIDENCE_THRESHOLD;

  const { data, error } = await supabase
    .from("company_config")
    .select("extraction_confidence_threshold")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    console.error("company_config lookup failed:", error.message);
    return DEFAULT_EXTRACTION_CONFIDENCE_THRESHOLD;
  }

  const raw = data?.extraction_confidence_threshold;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_EXTRACTION_CONFIDENCE_THRESHOLD;
  return Math.max(0, Math.min(1, n));
}

async function applyFieldFallbacks(
  imageUrl: string,
  fields: Pick<
    ExtractionResult,
    | "vendor_raw"
    | "total_amount"
    | "invoice_date"
    | "currency"
    | "tax_amount"
    | "invoice_number"
    | "due_date"
    | "customer_raw"
    | "po_number"
    | "line_items"
  >,
  threshold: number,
): Promise<ExtractionResult> {
  let aiFallbackUsed = false;
  const result = { ...fields } as ExtractionResult;
  result.raw_ocr_json = null;
  result.ai_fallback_used = false;
  result.threshold_used = threshold;

  const targets: ExtractableField[] = [
    "vendor_raw",
    "total_amount",
    "invoice_date",
  ];

  for (const field of targets) {
    const current = result[field];
    const ocrConfidence = current.confidence;
    const missing = current.value == null || current.value === "";
    result[field] = {
      ...current,
      ocr_confidence: ocrConfidence,
      ai_fallback_triggered: false,
    };

    // Keep Mindee when it produced a value at/above threshold.
    // Missing values always fall back; low real scores (v1) also fall back.
    // v2 null scores are resolved to 1 when a value exists (see resolveOcrConfidence).
    if (!missing && ocrConfidence >= threshold) continue;

    try {
      console.log(
        missing
          ? `OCR found no ${field}; running Gemini fallback`
          : `Low OCR confidence on ${field} (${ocrConfidence} < ${threshold}); running Gemini fallback`,
      );
      const replaced = await reExtractFieldWithGemini(imageUrl, field);
      result[field] = {
        value: replaced.value,
        confidence: replaced.confidence,
        source: "gemini",
        ocr_confidence: ocrConfidence,
        ai_fallback_triggered: true,
        gemini_raw: replaced.raw_text,
      };
      aiFallbackUsed = true;
    } catch (err) {
      // Per-field failure must not abort the whole extraction.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Gemini fallback failed for ${field}:`, message);
      result[field] = {
        ...result[field],
        ocr_confidence: ocrConfidence,
        ai_fallback_triggered: false,
      };
    }
  }

  // These fall back only when OCR found nothing — presence, not
  // confidence — so they never add Gemini cost when Mindee already read them.
  const presenceTargets: PresenceField[] = [
    "currency",
    "tax_amount",
    "invoice_number",
    "due_date",
    "customer_raw",
    "po_number",
  ];
  for (const field of presenceTargets) {
    const current = result[field];
    result[field] = {
      ...current,
      ocr_confidence: current.confidence,
      ai_fallback_triggered: false,
    };
    if (current.value != null) continue;

    try {
      console.log(`OCR found no ${field}; running Gemini fallback`);
      const replaced = await reExtractFieldWithGemini(imageUrl, field);
      result[field] = {
        value: replaced.value,
        confidence: replaced.confidence,
        source: "gemini",
        ocr_confidence: current.confidence,
        ai_fallback_triggered: true,
        gemini_raw: replaced.raw_text,
      };
      aiFallbackUsed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Gemini fallback failed for ${field}:`, message);
    }
  }

  // Line items: one Gemini call for the whole table, only when OCR found none.
  if (result.line_items.length === 0) {
    try {
      console.log("OCR found no line items; running Gemini fallback");
      const { items } = await extractLineItemsWithGemini(imageUrl);
      result.line_items = items.map((li) => ({
        description: li.description,
        quantity: li.quantity ?? 1,
        rate: li.unit_price,
        amount: li.amount,
        source: "gemini" as const,
      }));
      if (result.line_items.length > 0) aiFallbackUsed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Gemini line-items fallback failed:", message);
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
    threshold_used: extraction.threshold_used,
    vendor_raw: extraction.vendor_raw.confidence,
    total_amount: extraction.total_amount.confidence,
    invoice_date: extraction.invoice_date.confidence,
    ocr: {
      vendor_raw: extraction.vendor_raw.ocr_confidence ?? extraction.vendor_raw.confidence,
      total_amount:
        extraction.total_amount.ocr_confidence ?? extraction.total_amount.confidence,
      invoice_date:
        extraction.invoice_date.ocr_confidence ?? extraction.invoice_date.confidence,
    },
    fallback_triggered: {
      vendor_raw: Boolean(extraction.vendor_raw.ai_fallback_triggered),
      total_amount: Boolean(extraction.total_amount.ai_fallback_triggered),
      invoice_date: Boolean(extraction.invoice_date.ai_fallback_triggered),
    },
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
    currency: extraction.currency.value != null
      ? String(extraction.currency.value)
      : null,
    tax_amount: asNumber(extraction.tax_amount.value),
    invoice_number: extraction.invoice_number.value != null
      ? String(extraction.invoice_number.value)
      : null,
    due_date: asDateString(extraction.due_date.value),
    customer_raw: extraction.customer_raw.value != null
      ? String(extraction.customer_raw.value)
      : null,
    po_number: extraction.po_number.value != null
      ? String(extraction.po_number.value)
      : null,
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
  const extractedId = data.id as string;

  if (extraction.line_items.length > 0) {
    const lineRows = extraction.line_items.map((li, i) => ({
      document_id: documentId,
      extracted_fields_id: extractedId,
      line_no: i + 1,
      description: li.description,
      quantity: li.quantity,
      rate: li.rate,
      amount: li.amount,
      source: li.source,
    }));
    const { error: lineError } = await supabase
      .from("extracted_line_items")
      .insert(lineRows);
    if (lineError) {
      // Header extraction stands even if line detail fails; review can add lines.
      console.error(`extracted_line_items insert failed: ${lineError.message}`);
    }
  }

  return extractedId;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Human UI or ingest sibling (service_role). Reject anon-as-Bearer.
  const auth = await requireAuth(req, { allowServiceRole: true });
  if (isAuthFail(auth)) return auth.response;

  let input: ExtractInput;
  try {
    input = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!input?.document_id) {
    return jsonResponse({ error: "document_id is required" }, 400);
  }

  // This function runs with the service role, which bypasses row-level
  // security — so establish the document is the caller's before touching it.
  const tenant = await companyForCaller(auth, {
    documentId: input.document_id,
    errorBody: (m) => ({ error: m }),
  });
  if (isCompanyFail(tenant)) return tenant.response;

  const warnings: string[] = [];

  try {
    const supabase = getSupabase();

    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("id, file_url, doc_type, status, company_id")
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

    const threshold = await loadExtractionThreshold(supabase, doc.company_id);

    let prediction: Record<string, unknown> = {};
    let rawOcr: unknown = null;
    let visionImageUrl = doc.file_url;

    try {
      const loaded = await loadDocumentBytes(supabase, doc.file_url);
      visionImageUrl = bytesToDataUrl(loaded.bytes, loaded.contentType);
      const mindee = await callMindeeInvoice(supabase, doc.file_url);
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
      extraction = await applyFieldFallbacks(visionImageUrl, fields, threshold);
      extraction.raw_ocr_json = rawOcr;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Field fallback stage failed:", message);
      warnings.push(`fallback: ${message}`);
      extraction = {
        ...fields,
        raw_ocr_json: rawOcr,
        ai_fallback_used: false,
        threshold_used: threshold,
      };
    }

    try {
      const extractedId = await persistExtraction(supabase, doc.id, extraction);
      await supabase
        .from("documents")
        .update({ status: "extracted" })
        .eq("id", doc.id);

      const fieldReport = {
        vendor_raw: {
          value: extraction.vendor_raw.value,
          ocr_confidence: extraction.vendor_raw.ocr_confidence ??
            extraction.vendor_raw.confidence,
          final_confidence: extraction.vendor_raw.confidence,
          ai_fallback_triggered: Boolean(
            extraction.vendor_raw.ai_fallback_triggered,
          ),
          source: extraction.vendor_raw.source,
          gemini_raw: extraction.vendor_raw.gemini_raw ?? null,
        },
        total_amount: {
          value: extraction.total_amount.value,
          ocr_confidence: extraction.total_amount.ocr_confidence ??
            extraction.total_amount.confidence,
          final_confidence: extraction.total_amount.confidence,
          ai_fallback_triggered: Boolean(
            extraction.total_amount.ai_fallback_triggered,
          ),
          source: extraction.total_amount.source,
          gemini_raw: extraction.total_amount.gemini_raw ?? null,
        },
        invoice_date: {
          value: extraction.invoice_date.value,
          ocr_confidence: extraction.invoice_date.ocr_confidence ??
            extraction.invoice_date.confidence,
          final_confidence: extraction.invoice_date.confidence,
          ai_fallback_triggered: Boolean(
            extraction.invoice_date.ai_fallback_triggered,
          ),
          source: extraction.invoice_date.source,
          gemini_raw: extraction.invoice_date.gemini_raw ?? null,
        },
      };

      return jsonResponse({
        document_id: doc.id,
        company_id: doc.company_id,
        extracted_fields_id: extractedId,
        ok: true,
        extraction_confidence_threshold: threshold,
        ai_fallback_used: extraction.ai_fallback_used,
        field_report: fieldReport,
        confidence_scores: {
          vendor_raw: extraction.vendor_raw.confidence,
          total_amount: extraction.total_amount.confidence,
          invoice_date: extraction.invoice_date.confidence,
        },
        fields: {
          vendor_raw: extraction.vendor_raw.value,
          total_amount: extraction.total_amount.value,
          invoice_date: extraction.invoice_date.value,
          currency: extraction.currency.value,
          tax_amount: extraction.tax_amount.value,
          invoice_number: extraction.invoice_number.value,
          due_date: extraction.due_date.value,
          customer_raw: extraction.customer_raw.value,
          po_number: extraction.po_number.value,
          line_items: extraction.line_items,
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
