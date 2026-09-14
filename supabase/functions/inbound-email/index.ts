// Inbound email webhook (Mailgun).
// Receives mail to {company-slug}-{random}@INBOUND_EMAIL_DOMAIN, extracts
// attachments, and feeds them into the shared `ingest` function — same path
// as manual upload. No Gmail/Outlook OAuth.
//
// Auth: Mailgun HMAC signature only (not a user JWT) — see _shared/mailgun.ts
// for the timestamp window and replay check. After verify, calls ingest with
// service_role: a background job with no user behind it. Do not require
// Sign-in here.
//
// This is the only unauthenticated way into a client's books, so it refuses
// early and cheaply: oversized bodies before parsing, unsigned or replayed
// webhooks before reading attachments, and attachments whose bytes are not a
// PDF or image before they reach ingest (which scans them for malware).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { verifyMailgunWebhook } from "../_shared/mailgun.ts";
import { MAX_FILE_BYTES, sniffFileType } from "../_shared/file_safety.ts";

const CORS_HEADERS = corsHeaders("authorization, content-type, apikey, x-client-info");

/** Mailgun accepts messages up to 25 MB; leave room for multipart overhead. */
const MAX_BODY_BYTES = 40 * 1024 * 1024;
/** More attachments than this on one email is not an invoice run. */
const MAX_ATTACHMENTS = 10;
const EMAIL_ADDRESS = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,253}$/;

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

function normalizeRecipient(raw: string): string {
  // "Name <addr@dom>" or plain addr; take first address if comma-separated.
  const first = raw.split(",")[0]?.trim() ?? "";
  const angle = first.match(/<([^>]+)>/);
  return (angle?.[1] ?? first).trim().toLowerCase();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function callIngest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${base}/functions/v1/ingest`, {
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
    throw new Error(String(payload.error ?? text ?? res.status));
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

  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Expected multipart/form-data (Mailgun inbound). For local tests use scripts/inbound-email-accuracy.mjs",
        },
        400,
      );
    }

    // Refuse an oversized body before parsing it: formData() buffers it all.
    const declaredLength = Number(req.headers.get("content-length") ?? NaN);
    if (!Number.isFinite(declaredLength)) {
      return jsonResponse({ ok: false, error: "Content-Length is required" }, 411);
    }
    if (declaredLength > MAX_BODY_BYTES) {
      return jsonResponse({ ok: false, error: "Message too large" }, 413);
    }

    const form = await req.formData();
    const supabase = getSupabase();
    const verdict = await verifyMailgunWebhook(supabase, {
      timestamp: String(form.get("timestamp") ?? ""),
      token: String(form.get("token") ?? ""),
      signature: String(form.get("signature") ?? ""),
    });
    if (!verdict.ok) {
      console.warn(`inbound-email refused: ${verdict.reason}`);
      return jsonResponse({ ok: false, error: "Invalid Mailgun signature" }, 401);
    }

    const recipientRaw = String(
      form.get("recipient") ?? form.get("To") ?? form.get("to") ?? "",
    );
    const recipient = normalizeRecipient(recipientRaw);
    if (!recipient || !EMAIL_ADDRESS.test(recipient)) {
      return jsonResponse({ ok: false, error: "Missing recipient" }, 400);
    }

    const sender = String(form.get("sender") ?? form.get("from") ?? form.get("From") ?? "") ||
      null;
    const subject = String(form.get("subject") ?? form.get("Subject") ?? "") || null;

    // Exact match. This was .ilike(), where % and _ are wildcards: mail to
    // acme-%@… matched Acme's address without knowing its random suffix.
    // Addresses are stored lower-case (enforced by constraint).
    const { data: company, error: coErr } = await supabase
      .from("company_config")
      .select("company_id")
      .eq("inbound_email", recipient)
      .maybeSingle();

    if (coErr) throw new Error("Could not look up the inbound address");
    if (!company) {
      return jsonResponse({ ok: false, error: "No company mapped to that inbound address" }, 404);
    }

    // Mailgun: attachment-1..N plus attachment-count. Some providers / local
    // harnesses send a single "attachment" or "file" instead.
    const files: File[] = [];
    const count = Math.min(Number(form.get("attachment-count") ?? 0) || 0, MAX_ATTACHMENTS + 1);
    if (count > 0) {
      for (let i = 1; i <= count; i++) {
        const file = form.get(`attachment-${i}`);
        if (file instanceof File) files.push(file);
      }
    } else {
      for (const [key, value] of form.entries()) {
        if (value instanceof File && (key.startsWith("attachment") || key === "file")) {
          files.push(value);
        }
      }
    }
    if (files.length > MAX_ATTACHMENTS) {
      return jsonResponse({ ok: false, error: `More than ${MAX_ATTACHMENTS} attachments` }, 413);
    }

    // The type is what the bytes are, not what the sender claims.
    const attachments: Array<{ filename: string; type: string; bytes: Uint8Array }> = [];
    for (const [i, file] of files.entries()) {
      if (file.size === 0 || file.size > MAX_FILE_BYTES) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const type = sniffFileType(bytes);
      if (!type) continue;
      attachments.push({ filename: file.name || `attachment-${i + 1}`, type, bytes });
    }

    if (attachments.length === 0) {
      return jsonResponse(
        { ok: false, error: "No PDF/image attachment found on inbound email" },
        400,
      );
    }

    const ingested: Array<Record<string, unknown>> = [];
    for (const att of attachments) {
      const result = await callIngest({
        company_id: company.company_id,
        source: "email",
        filename: att.filename,
        content_type: att.type,
        file_base64: bytesToBase64(att.bytes),
        sender,
      });
      ingested.push({
        document_id: result.document_id,
        document: result.document,
        filename: att.filename,
      });
    }

    return jsonResponse({
      ok: true,
      provider: "mailgun",
      recipient,
      sender,
      subject,
      company_id: company.company_id,
      documents: ingested,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("inbound-email failed:", message);
    // The caller is unauthenticated: no internal detail in the answer.
    return jsonResponse({ ok: false, error: "Inbound email could not be processed" }, 500);
  }
});
