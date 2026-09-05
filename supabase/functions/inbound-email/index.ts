// Inbound email webhook (Mailgun).
// Receives mail to {company-slug}-{random}@INBOUND_EMAIL_DOMAIN, extracts
// attachments, and feeds them into the shared `ingest` function — same path
// as manual upload. No Gmail/Outlook OAuth.
//
// Auth: Mailgun HMAC signature only (not a user JWT). After verify, calls
// ingest with service_role. Do not require Sign-in here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info",
};

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

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

/** Mailgun webhook signature check. Skipped when MAILGUN_WEBHOOK_SKIP_VERIFY=true. */
async function verifyMailgunSignature(
  timestamp: string,
  token: string,
  signature: string,
): Promise<boolean> {
  if ((Deno.env.get("MAILGUN_WEBHOOK_SKIP_VERIFY") ?? "").toLowerCase() === "true") {
    return true;
  }
  const key = Deno.env.get("MAILGUN_SIGNING_KEY")?.trim();
  if (!key) {
    throw new Error(
      "MAILGUN_SIGNING_KEY is not set (or set MAILGUN_WEBHOOK_SKIP_VERIFY=true for local tests)",
    );
  }
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    enc.encode(timestamp + token),
  );
  const hex = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === signature;
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

    const form = await req.formData();
    const timestamp = String(form.get("timestamp") ?? "");
    const token = String(form.get("token") ?? "");
    const signature = String(form.get("signature") ?? "");
    if (!(await verifyMailgunSignature(timestamp, token, signature))) {
      return jsonResponse({ ok: false, error: "Invalid Mailgun signature" }, 401);
    }

    const recipientRaw = String(
      form.get("recipient") ?? form.get("To") ?? form.get("to") ?? "",
    );
    const recipient = normalizeRecipient(recipientRaw);
    if (!recipient) {
      return jsonResponse({ ok: false, error: "Missing recipient" }, 400);
    }

    const sender = String(form.get("sender") ?? form.get("from") ?? form.get("From") ?? "") ||
      null;
    const subject = String(form.get("subject") ?? form.get("Subject") ?? "") || null;

    const supabase = getSupabase();
    const { data: company, error: coErr } = await supabase
      .from("company_config")
      .select("company_id, inbound_email, company_slug")
      .ilike("inbound_email", recipient)
      .maybeSingle();

    if (coErr) throw new Error(coErr.message);
    if (!company) {
      return jsonResponse(
        {
          ok: false,
          error: `No company mapped to inbound address ${recipient}`,
        },
        404,
      );
    }

    // Mailgun: attachment-1..N plus attachment-count
    const attachments: Array<{ filename: string; type: string; bytes: Uint8Array }> = [];
    const count = Number(form.get("attachment-count") ?? 0);
    if (count > 0) {
      for (let i = 1; i <= count; i++) {
        const file = form.get(`attachment-${i}`);
        if (file instanceof File) {
          const type = (file.type || "application/octet-stream").split(";")[0];
          if (!ALLOWED_TYPES.has(type) && !file.name.toLowerCase().endsWith(".pdf")) {
            continue;
          }
          attachments.push({
            filename: file.name || `attachment-${i}.pdf`,
            type: ALLOWED_TYPES.has(type) ? type : "application/pdf",
            bytes: new Uint8Array(await file.arrayBuffer()),
          });
        }
      }
    } else {
      // Some providers / local harnesses send a single "attachment"
      for (const [key, value] of form.entries()) {
        if (value instanceof File && (key.startsWith("attachment") || key === "file")) {
          const type = (value.type || "application/octet-stream").split(";")[0];
          if (!ALLOWED_TYPES.has(type) && !value.name.toLowerCase().endsWith(".pdf")) {
            continue;
          }
          attachments.push({
            filename: value.name || "attachment.pdf",
            type: ALLOWED_TYPES.has(type) ? type : "application/pdf",
            bytes: new Uint8Array(await value.arrayBuffer()),
          });
        }
      }
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
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
