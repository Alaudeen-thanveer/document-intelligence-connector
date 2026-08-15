/**
 * Gemini vision fallback for low-OCR-confidence fields.
 * Uses GEMINI_API_KEY + @google/generative-ai (Flash-tier, not 2.5).
 */
import { GoogleGenerativeAI } from "npm:@google/generative-ai@0.24.1";

export type ExtractableField =
  | "vendor_raw"
  | "total_amount"
  | "invoice_date"
  | "currency"
  | "tax_amount"
  | "invoice_number"
  | "due_date"
  | "customer_raw";

/** One invoice line as Gemini reports it (all fields nullable). */
export interface GeminiLineItem {
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  amount: number | null;
}

export interface GeminiFieldValue {
  value: string | number | null;
  confidence: number;
  source: "gemini";
  raw_text: string;
}

// Free Flash-tier default. Avoid gemini-2.5-* (deprecated) and shut-down 2.0 ids.
const DEFAULT_MODEL = "gemini-3.6-flash";

function getHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { status?: number; statusCode?: number; httpStatusCode?: number };
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.httpStatusCode === "number") return e.httpStatusCode;
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/\b(429)\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Retry wrapper for free-tier rate limits (HTTP 429 only).
 * Exported for the deliberate 429 accuracy test.
 */
export async function withRetryOn429<T>(
  fn: () => Promise<T>,
  opts?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ result: T; attempts: number }> {
  const maxAttempts = opts?.maxAttempts ?? 4;
  const baseDelayMs = opts?.baseDelayMs ?? 500;
  const sleep = opts?.sleep ??
    ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (err) {
      lastErr = err;
      const status = getHttpStatus(err);
      if (status !== 429 || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `Gemini HTTP 429; retry ${attempt}/${maxAttempts} after ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) {
    throw new Error("Gemini fallback expects a data URL image/PDF payload");
  }
  return { mimeType: m[1], base64: m[2] };
}

function extractJsonObject(text: string): unknown {
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

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number"
    ? value
    : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function asDateString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

const FIELD_INSTRUCTIONS: Record<ExtractableField, string> = {
  vendor_raw:
    'Extract only the vendor / supplier name. Return JSON only: {"value": string|null, "confidence": number between 0 and 1}',
  total_amount:
    'Extract only the invoice total amount as a number. Return JSON only: {"value": number|null, "confidence": number between 0 and 1}',
  invoice_date:
    'Extract only the invoice date as YYYY-MM-DD. Return JSON only: {"value": string|null, "confidence": number between 0 and 1}',
  currency:
    'Extract only the invoice currency as a 3-letter ISO code (e.g. AED, USD, EUR). Infer from the currency symbol or text if no code is printed. Return JSON only: {"value": string|null, "confidence": number between 0 and 1}',
  tax_amount:
    'Extract only the total VAT/tax amount as a number in the invoice currency. If the invoice shows no VAT/tax line, return null. Return JSON only: {"value": number|null, "confidence": number between 0 and 1}',
  invoice_number:
    'Extract only the invoice/bill number as printed on the document (e.g. INV-2210). Return JSON only: {"value": string|null, "confidence": number between 0 and 1}',
  due_date:
    'Extract only the payment due date as YYYY-MM-DD. If no due date is printed, return null. Return JSON only: {"value": string|null, "confidence": number between 0 and 1}',
  customer_raw:
    'Extract only the BILL-TO / customer name — the party this invoice is addressed to, NOT the issuer. If there is no bill-to party, return null. Return JSON only: {"value": string|null, "confidence": number between 0 and 1}',
};

export async function reExtractFieldWithGemini(
  imageDataUrl: string,
  field: ExtractableField,
): Promise<GeminiFieldValue> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const modelName = Deno.env.get("GEMINI_MODEL")?.trim() || DEFAULT_MODEL;
  if (modelName.includes("2.5")) {
    throw new Error(
      `GEMINI_MODEL=${modelName} is not allowed (2.5 line deprecated). Use a free Flash-tier model such as gemini-3.6-flash.`,
    );
  }

  const { mimeType, base64 } = parseDataUrl(imageDataUrl);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  });

  const prompt = [
    "You extract a single invoice field from the attached document.",
    "Gemini does not provide a native confidence score — you MUST self-report confidence.",
    'Respond with parseable JSON only, shape: {"value": ..., "confidence": 0-1}.',
    "Do not extract any other fields. No markdown.",
    FIELD_INSTRUCTIONS[field],
  ].join(" ");

  const { result: response, attempts } = await withRetryOn429(async () => {
    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType, data: base64 } },
    ]);
    return result.response;
  });

  if (attempts > 1) {
    console.log(`Gemini succeeded for ${field} after ${attempts} attempts`);
  }

  const rawText = response.text();
  let parsed: { value?: unknown; confidence?: unknown };
  try {
    parsed = extractJsonObject(rawText) as {
      value?: unknown;
      confidence?: unknown;
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Gemini JSON validation failed for ${field}: ${message}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("value" in parsed) ||
    !("confidence" in parsed)
  ) {
    throw new Error(
      `Gemini JSON missing value/confidence for ${field}: ${rawText}`,
    );
  }

  const confidenceNum = Number(parsed.confidence);
  if (!Number.isFinite(confidenceNum)) {
    throw new Error(
      `Gemini confidence is not a number for ${field}: ${rawText}`,
    );
  }
  const confidence = Math.max(0, Math.min(1, confidenceNum));

  if (field === "total_amount" || field === "tax_amount") {
    return {
      value: asNumber(parsed.value),
      confidence,
      source: "gemini",
      raw_text: rawText,
    };
  }
  if (field === "currency") {
    const code = parsed.value != null
      ? String(parsed.value).trim().toUpperCase()
      : null;
    return {
      value: code && /^[A-Z]{3}$/.test(code) ? code : null,
      confidence,
      source: "gemini",
      raw_text: rawText,
    };
  }
  if (field === "invoice_date" || field === "due_date") {
    return {
      value: asDateString(parsed.value),
      confidence,
      source: "gemini",
      raw_text: rawText,
    };
  }
  return {
    value: parsed.value != null ? String(parsed.value) : null,
    confidence,
    source: "gemini",
    raw_text: rawText,
  };
}

/**
 * Extract ALL invoice line items in one Gemini call. Used only when OCR
 * returned no line items at all (presence-based, like currency/tax).
 */
export async function extractLineItemsWithGemini(
  imageDataUrl: string,
): Promise<{ items: GeminiLineItem[]; raw_text: string }> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const modelName = Deno.env.get("GEMINI_MODEL")?.trim() || DEFAULT_MODEL;
  const { mimeType, base64 } = parseDataUrl(imageDataUrl);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  });

  const prompt = [
    "Extract every line item from the attached invoice table.",
    "Do NOT include subtotal, VAT/tax, discount, or total rows — only real goods/services lines.",
    'Respond with parseable JSON only, shape: {"items": [{"description": string|null, "quantity": number|null, "unit_price": number|null, "amount": number|null}]}.',
    "amount is the printed line total. If the invoice has a single implicit line, return that one line. No markdown.",
  ].join(" ");

  const { result: response } = await withRetryOn429(async () => {
    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType, data: base64 } },
    ]);
    return result.response;
  });

  const rawText = response.text();
  const parsed = extractJsonObject(rawText) as { items?: unknown };
  const items = Array.isArray(parsed?.items) ? parsed.items : [];

  return {
    items: items.map((it) => {
      const o = it as Record<string, unknown>;
      return {
        description: o.description != null ? String(o.description) : null,
        quantity: asNumber(o.quantity),
        unit_price: asNumber(o.unit_price),
        amount: asNumber(o.amount),
      };
    }).filter((li) => li.description || li.amount != null || li.unit_price != null),
    raw_text: rawText,
  };
}
