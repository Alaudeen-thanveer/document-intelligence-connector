// Shared document ingest — used by manual upload AND inbound email.
// Uploads to the invoices bucket (if bytes provided), creates a documents
// row, then runs extract + judgment. One path only; no parallel pipeline.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { type AuthOk, isAuthFail, requireAuth } from "../_shared/require_user.ts";
import { dataClient, siblingHeaders } from "../_shared/db.ts";
import { companyForCaller, isCompanyFail } from "../_shared/tenant.ts";
import { assertSafeFile, MAX_FILE_BYTES, UnsafeFile } from "../_shared/file_safety.ts";
import { companyObjectPath, StoredFileRefused, storageRef } from "../_shared/storage.ts";

const CORS_HEADERS = corsHeaders();

type IngestSource = "upload" | "email" | "webhook";

interface IngestInput {
  company_id?: string;
  source?: IngestSource;
  filename: string;
  content_type?: string;
  /** Raw file as base64 (preferred for email + upload-via-ingest). */
  file_base64?: string;
  /**
   * An object already in the invoices bucket (storage://invoices/{company}/…).
   * Must sit under the caller's company; external URLs are refused.
   */
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

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "document.pdf";
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^;]+;base64,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Hand off to extract / judgment AS THE SAME CALLER: a person's JWT is passed
 * through, so the sibling acts as them under row-level security; only the
 * mailbox pipeline (a background job) continues as the service role.
 */
async function callSibling(
  name: "extract" | "judgment",
  body: Record<string, unknown>,
  auth: AuthOk,
  companyId: string,
): Promise<Record<string, unknown>> {
  const base = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  const res = await fetch(`${base}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...siblingHeaders(auth, companyId),
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
  const source: IngestSource = input.source ?? "upload";

  // A caller naming a company that is not theirs is refused outright rather
  // than quietly served their own — with two clients open, silently switching
  // which one a document lands in is worse than an error.
  const tenant = await companyForCaller(auth, {
    companyId: input.company_id ?? null,
    errorBody: (m) => ({ ok: false, error: m }),
  });
  if (isCompanyFail(tenant)) return tenant.response;

  // The guard's answer is the answer. This used to be overridden by a
  // company_id stamped on the login account — computed the right company,
  // then threw it away — and refused anyone without a stamp. A person who
  // serves several clients has one login; the request names the client
  // (the browser sends the company it is showing), and membership decides.
  const companyId = tenant.companyId;

  if (!input.file_base64 && !input.file_url) {
    return jsonResponse(
      { ok: false, error: "Provide file_base64 or file_url" },
      400,
    );
  }

  // Base64 is 4/3 the size of the file; refuse an oversized one before decoding.
  if (input.file_base64 && input.file_base64.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 64) {
    return jsonResponse({ ok: false, error: "The file is larger than the upload limit." }, 413);
  }

  try {
    // The uploader's own identity (RLS and the storage policy apply to the
    // upload and the row); the service role only for the mailbox pipeline.
    const supabase = dataClient(auth, companyId);
    let fileUrl = "";

    if (input.file_base64) {
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(input.file_base64);
      } catch {
        return jsonResponse({ ok: false, error: "file_base64 is not valid base64" }, 400);
      }
      // Size, real type from the bytes, and a malware scan — before storage.
      // The stored Content-Type is what the bytes are, not what was claimed.
      const contentType = await assertSafeFile(bytes, filename);
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
      fileUrl = storageRef(path);
    } else {
      // Only an object already in this company's folder of the store; never
      // an arbitrary URL, never another company's file.
      fileUrl = storageRef(companyObjectPath(input.file_url, companyId));
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
    const extract = await callSibling("extract", { document_id: documentId }, auth, companyId);
    let judgment: Record<string, unknown> | null = null;
    if (!input.skip_judgment) {
      judgment = await callSibling("judgment", { document_id: documentId }, auth, companyId);
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
    if (err instanceof UnsafeFile) {
      return jsonResponse({ ok: false, error: message }, 422);
    }
    if (err instanceof StoredFileRefused) {
      return jsonResponse({ ok: false, error: message }, 404);
    }
    console.error("ingest failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
