// Triage inbound documents: cheap heuristics first, LLM only when ambiguous.
// Classifies into: invoice | purchase_order | tax_notice | irrelevant
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type DocType = "invoice" | "purchase_order" | "tax_notice" | "irrelevant";

interface TriageInput {
  file_url: string;
  sender: string;
  filename: string;
  /** Existing documents.id to update; if omitted, a new row is created. */
  document_id?: string;
  source?: string;
}

interface Classification {
  doc_type: DocType;
  confidence: number;
  method: "heuristic" | "llm";
  reason: string;
}

const DOC_TYPES: DocType[] = [
  "invoice",
  "purchase_order",
  "tax_notice",
  "irrelevant",
];

/** Heuristic confidence high enough to skip the LLM. */
const HEURISTIC_CONFIDENCE_THRESHOLD = 0.85;

const FILENAME_RULES: Array<{ doc_type: DocType; patterns: RegExp[] }> = [
  {
    doc_type: "invoice",
    patterns: [
      /\binvoice\b/i,
      /\binv[-_\s]?\d/i,
      /\bbill[-_\s]?\d/i,
      /\btax[-_\s]?invoice\b/i,
    ],
  },
  {
    doc_type: "purchase_order",
    patterns: [
      /\bpurchase[-_\s]?order\b/i,
      /\bpo[-_\s]?\d/i,
      /\bpur[-_\s]?ord/i,
    ],
  },
  {
    doc_type: "tax_notice",
    patterns: [
      /\btax[-_\s]?notice\b/i,
      /\birs\b/i,
      /\b1099\b/i,
      /\bw[-_]?2\b/i,
      /\bvat[-_\s]?notice\b/i,
      /\bassessment[-_\s]?notice\b/i,
    ],
  },
  {
    doc_type: "irrelevant",
    patterns: [
      /\bnewsletter\b/i,
      /\bmarketing\b/i,
      /\bpromo(tion)?\b/i,
      /\bunsubscribe\b/i,
    ],
  },
];

const SENDER_RULES: Array<{ doc_type: DocType; patterns: RegExp[] }> = [
  {
    doc_type: "invoice",
    patterns: [
      /^billing@/i,
      /^invoices?@/i,
      /^accounts?\.?payable@/i,
      /^ap@/i,
      /@bill\./i,
      /@stripe\.com$/i,
      /@intuit\.com$/i,
    ],
  },
  {
    doc_type: "purchase_order",
    patterns: [/^po@/i, /^purchasing@/i, /^procurement@/i, /^buyers?@/i],
  },
  {
    doc_type: "tax_notice",
    patterns: [
      /@irs\.gov$/i,
      /@ftb\.ca\.gov$/i,
      /@state\.[a-z]+\.us$/i,
      /^tax(?:es)?@/i,
      /@hmrc\.gov\.uk$/i,
    ],
  },
  {
    doc_type: "irrelevant",
    patterns: [
      /^noreply@.*newsletter/i,
      /@mailchimp\.com$/i,
      /@marketing\./i,
    ],
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function classifyByHeuristics(
  filename: string,
  sender: string,
): Classification | null {
  for (const rule of FILENAME_RULES) {
    if (rule.patterns.some((p) => p.test(filename))) {
      return {
        doc_type: rule.doc_type,
        confidence: 0.92,
        method: "heuristic",
        reason: `filename matched ${rule.doc_type} keyword`,
      };
    }
  }

  const senderNorm = sender.trim().toLowerCase();
  for (const rule of SENDER_RULES) {
    if (rule.patterns.some((p) => p.test(senderNorm))) {
      return {
        doc_type: rule.doc_type,
        confidence: 0.9,
        method: "heuristic",
        reason: `sender matched ${rule.doc_type} pattern`,
      };
    }
  }

  return null;
}

/** Pull a bounded amount of text, preferring content that looks like page 1. */
async function extractPage1Text(fileUrl: string): Promise<string> {
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch file (${res.status}): ${fileUrl}`);
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const bytes = new Uint8Array(await res.arrayBuffer());
  const maxChars = 4000;

  if (
    contentType.includes("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("csv")
  ) {
    return new TextDecoder("utf-8", { fatal: false })
      .decode(bytes)
      .slice(0, maxChars);
  }

  // Best-effort PDF / binary text scrape: take early latin runs only (page-1 bias).
  const asLatin = new TextDecoder("latin1").decode(bytes.slice(0, 512_000));
  const pageBreak = asLatin.search(/\/Type\s*\/Page[^s]|\/Page\s*<<|formfeed|\f/);
  const window = pageBreak > 0 ? asLatin.slice(0, pageBreak) : asLatin.slice(0, 120_000);

  const runs = window.match(/[\x20-\x7E\n\r\t]{4,}/g) ?? [];
  const text = runs.join(" ").replace(/\s+/g, " ").trim();
  if (text.length >= 40) return text.slice(0, maxChars);

  // Fall back to raw UTF-8 decode of the head of the file.
  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 24_000))
    .slice(0, maxChars);
}

async function classifyWithLlm(page1Text: string): Promise<Classification> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  const baseUrl = Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
  const model = Deno.env.get("TRIAGE_LLM_MODEL") ?? "gpt-4o-mini";

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const system = [
    "You classify inbound business documents for an accounting pipeline.",
    "Use ONLY the provided page-1 text.",
    "Return strict JSON: {\"doc_type\":\"invoice|purchase_order|tax_notice|irrelevant\",\"confidence\":0-1,\"reason\":\"short\"}.",
    "No markdown, no extra keys.",
  ].join(" ");

  const user = `Page 1 text:\n"""\n${page1Text.slice(0, 3500)}\n"""`;

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
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM classify failed (${res.status}): ${errText}`);
  }

  const payload = await res.json();
  const content = payload?.choices?.[0]?.message?.content ?? "{}";
  let parsed: { doc_type?: string; confidence?: number; reason?: string };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`LLM returned non-JSON: ${content}`);
  }

  const docType = DOC_TYPES.includes(parsed.doc_type as DocType)
    ? (parsed.doc_type as DocType)
    : "irrelevant";
  const confidence = Math.max(
    0,
    Math.min(1, Number(parsed.confidence ?? 0.5)),
  );

  return {
    doc_type: docType,
    confidence,
    method: "llm",
    reason: parsed.reason ?? "llm classification",
  };
}

async function persistClassification(
  input: TriageInput,
  classification: Classification,
): Promise<{ document_id: string }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const fields = {
    doc_type: classification.doc_type,
    confidence: classification.confidence,
    status: "triaged",
    file_url: input.file_url,
  };

  if (input.document_id) {
    const { data, error } = await supabase
      .from("documents")
      .update(fields)
      .eq("id", input.document_id)
      .select("id")
      .single();
    if (error) throw new Error(`documents update failed: ${error.message}`);
    return { document_id: data.id as string };
  }

  const { data, error } = await supabase
    .from("documents")
    .insert({
      ...fields,
      source: input.source ?? "webhook",
      file_url: input.file_url,
    })
    .select("id")
    .single();
  if (error) throw new Error(`documents insert failed: ${error.message}`);
  return { document_id: data.id as string };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let input: TriageInput;
  try {
    input = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!input?.file_url || !input?.sender || !input?.filename) {
    return jsonResponse(
      { error: "file_url, sender, and filename are required" },
      400,
    );
  }

  try {
    let classification = classifyByHeuristics(input.filename, input.sender);

    if (
      !classification ||
      classification.confidence < HEURISTIC_CONFIDENCE_THRESHOLD
    ) {
      const page1 = await extractPage1Text(input.file_url);
      classification = await classifyWithLlm(page1);
    }

    const { document_id } = await persistClassification(input, classification);

    return jsonResponse({
      document_id,
      doc_type: classification.doc_type,
      confidence: classification.confidence,
      method: classification.method,
      reason: classification.reason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("triage failed:", message);
    return jsonResponse({ error: message }, 500);
  }
});
