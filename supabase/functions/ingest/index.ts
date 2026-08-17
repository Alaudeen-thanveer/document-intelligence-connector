// Shared document ingest — used by manual upload AND inbound email.
// Uploads to the invoices bucket (if bytes provided), creates a documents
// row, then runs extract + judgment. One path only; no parallel pipeline.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { isAuthFail, requireAuth } from "../_shared/require_user.ts";

const DEFAULT_COMPANY = "00000000-0000-4000-8000-000000000001";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info, x-action-id, x-actor",
};

type IngestSource = "upload" | "email" | "webhook";

interface IngestInput {
  company_id?: string;
  source?: IngestSource;
  filename: string;
  content_type?: string;
  /** Raw file as base64 (preferred for email + upload-via-ingest). */
  file_base64?: string;
  /** Already-uploaded public storage URL (legacy upload path). */
  file_url?: string;
  sender?: string | null;
  /** When true, skip judgment (tests only). Default false. */
  skip_judgment?: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function requireEnv(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function getSupabase(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "document.pdf";
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^;]+;base64,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function callSibling(
  name: "extract" | "judgment",
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const base = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${base}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      apikey: key,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `HTTP ${res.status}` };
  }
  if (!res.ok || payload.ok === false) {
    throw new Error(
      `${name} failed: ${
        payload.error ?? payload.reason ?? text ?? res.status
      }`,
    );
  }
  return payload;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  // Browser upload = user JWT; inbound-email sibling = service_role.
  const auth = await requireAuth(req, {
    allowServiceRole: true,
    corsHeaders: CORS_HEADERS,
  });
  if (isAuthFail(auth)) return auth.response;

  let input: IngestInput;
  try {
    input = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const filename = sanitizeFilename(input.filename ?? "document.pdf");
  const contentType = (input.content_type ?? "application/pdf").split(";")[0]
    .trim() || "application/pdf";
  const source: IngestSource = input.source ?? "upload";

  // User uploads: company comes from JWT app_metadata (ignore client spoof).
  // Service/email path: may pass company_id explicitly.
  let companyId = DEFAULT_COMPANY;
  if (auth.user) {
    const claim = auth.user.app_metadata?.company_id;
    if (typeof claim === "string" && claim.trim()) {
      companyId = claim.trim();
    } else {
      return jsonResponse(
        {
          ok: false,
          error:
            "No company_id on this account. Ask an admin to add you to company_members and set app_metadata.company_id, then sign out/in.",
        },
        403,
      );
    }
  } else if (input.company_id?.trim()) {
    companyId = input.company_id.trim();
  }

  if (!input.file_base64 && !input.file_url) {
    return jsonResponse(
      { ok: false, error: "Provide file_base64 or file_url" },
      400,
    );
  }

  try {
    const supabase = getSupabase();
    let fileUrl = input.file_url?.trim() ?? "";

    if (input.file_base64) {
      const bytes = decodeBase64(input.file_base64);
      // Private bucket path: {company_id}/{uuid}-{filename}
      const path = `${companyId}/${crypto.randomUUID()}-${filename}`;
      const { error: upErr } = await supabase.storage
        .from("invoices")
        .upload(path, bytes, {
          contentType,
          upsert: false,
          cacheControl: "3600",
        });
      if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
      // Stable storage ref (not a public URL). UI uses signed URLs to open.
      fileUrl = `storage://invoices/${path}`;
    }

    const { data: doc, error: insertError } = await supabase
      .from("documents")
      .insert({
        source,
        file_url: fileUrl,
        status: "uploaded",
        doc_type: "invoice",
        has_supporting_document: true,
        company_id: companyId,
      })
      .select("id, source, file_url, status, doc_type, company_id, uploaded_at")
      .single();

    if (insertError || !doc) {
      throw new Error(insertError?.message ?? "Failed to create document row");
    }

    const documentId = doc.id as string;
    const extract = await callSibling("extract", { document_id: documentId });
    let judgment: Record<string, unknown> | null = null;
    if (!input.skip_judgment) {
      judgment = await callSibling("judgment", { document_id: documentId });
    }

    const { data: finalDoc } = await supabase
      .from("documents")
      .select("id, source, file_url, status, doc_type, company_id, uploaded_at")
      .eq("id", documentId)
      .single();

    return jsonResponse({
      ok: true,
      document_id: documentId,
      document: finalDoc ?? doc,
      extract,
      judgment,
      sender: input.sender ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("ingest failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
