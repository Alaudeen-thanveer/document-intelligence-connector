// Push a judged, entity-resolved invoice bill to Zoho Books.
// Credentials come only from environment variables — never hardcoded.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  mapExtractedFieldsToZohoBill,
  type ExtractedFieldsRow,
  type ZohoBillMapped,
} from "./mapping.ts";
import {
  matchEntities,
  type ZohoAccount,
  type ZohoVendor,
} from "./match-entities.ts";

interface PushInput {
  document_id: string;
  /** Optional expense category hint for GL matching. */
  expense_category?: string | null;
  /** Cached Zoho vendors; falls back to ZOHO_VENDORS_JSON env. */
  vendors?: ZohoVendor[];
  /** Cached chart of accounts; falls back to ZOHO_ACCOUNTS_JSON env. */
  accounts?: ZohoAccount[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
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

function parseJsonEnv<T>(name: string): T | null {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function toZohoBillBody(bill: ZohoBillMapped): Record<string, unknown> {
  if (!bill.vendor_id) {
    throw new Error("vendor_id is required before Zoho push");
  }
  for (const item of bill.line_items) {
    if (!item.account_id) {
      throw new Error("account_id is required on line items before Zoho push");
    }
  }

  return {
    vendor_id: bill.vendor_id,
    date: bill.date,
    ...(bill.reference_number
      ? { reference_number: bill.reference_number }
      : {}),
    line_items: bill.line_items.map((item) => ({
      description: item.description,
      rate: item.rate,
      quantity: item.quantity,
      account_id: item.account_id,
    })),
  };
}

/** Exchange refresh token for a new access token (OAuth2). */
async function refreshAccessToken(): Promise<string> {
  const clientId = requireEnv("ZOHO_CLIENT_ID");
  const clientSecret = requireEnv("ZOHO_CLIENT_SECRET");
  const refreshToken = requireEnv("ZOHO_REFRESH_TOKEN");
  const accountsUrl =
    Deno.env.get("ZOHO_ACCOUNTS_URL")?.trim() || "https://accounts.zoho.com";

  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });

  const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const payload = await res.json();
  if (!res.ok || !payload?.access_token) {
    throw new Error(
      `Zoho token refresh failed (${res.status}): ${JSON.stringify(payload)}`,
    );
  }
  return String(payload.access_token);
}

async function createZohoBill(
  accessToken: string,
  billBody: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; externalDocId?: string; raw: unknown }> {
  const orgId = requireEnv("ZOHO_ORGANIZATION_ID");
  const apiBase =
    Deno.env.get("ZOHO_API_BASE_URL")?.trim() ||
    "https://www.zohoapis.com/books/v3";

  const url = `${apiBase}/bills?organization_id=${encodeURIComponent(orgId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(billBody),
  });

  const raw = await res.json().catch(async () => await res.text());
  if (!res.ok) {
    return { ok: false, status: res.status, raw };
  }

  const externalDocId =
    (raw as { bill?: { bill_id?: string } })?.bill?.bill_id ??
    (raw as { bill_id?: string })?.bill_id;

  return {
    ok: true,
    status: res.status,
    externalDocId: externalDocId != null ? String(externalDocId) : undefined,
    raw,
  };
}

/**
 * POST bill to Zoho; on auth/transient failure refresh token and retry once.
 */
async function pushBillWithRetry(
  billBody: Record<string, unknown>,
): Promise<{ externalDocId: string; raw: unknown; retried: boolean }> {
  let accessToken = Deno.env.get("ZOHO_ACCESS_TOKEN")?.trim() || "";
  let retried = false;

  if (!accessToken) {
    accessToken = await refreshAccessToken();
  }

  let result = await createZohoBill(accessToken, billBody);

  if (!result.ok) {
    const shouldRetry =
      result.status === 401 ||
      result.status === 403 ||
      result.status >= 500;

    if (!shouldRetry) {
      throw new Error(
        `Zoho bill create failed (${result.status}): ${JSON.stringify(result.raw)}`,
      );
    }

    console.log(
      `Zoho bill create failed (${result.status}); refreshing token and retrying once`,
    );
    accessToken = await refreshAccessToken();
    retried = true;
    result = await createZohoBill(accessToken, billBody);

    if (!result.ok) {
      throw new Error(
        `Zoho bill create failed after retry (${result.status}): ${JSON.stringify(result.raw)}`,
      );
    }
  }

  if (!result.externalDocId) {
    throw new Error(
      `Zoho bill create succeeded but no bill_id in response: ${JSON.stringify(result.raw)}`,
    );
  }

  return { externalDocId: result.externalDocId, raw: result.raw, retried };
}

async function assertJudgmentsPassed(
  supabase: SupabaseClient,
  documentId: string,
): Promise<{ judgmentResultId: string | null }> {
  const { data, error } = await supabase
    .from("judgment_results")
    .select("id, rule_name, passed, notes")
    .eq("document_id", documentId);

  if (error) {
    throw new Error(`Failed to load judgment_results: ${error.message}`);
  }

  const rows = data ?? [];
  if (rows.length === 0) {
    throw new Error(
      "No judgment_results found — document is not ready for Zoho push",
    );
  }

  const failed = rows.filter((r) => !r.passed);
  if (failed.length > 0) {
    const names = failed.map((r) => r.rule_name).join(", ");
    throw new Error(`Judgment failed for rule(s): ${names}`);
  }

  // Link sync log to the latest passing judgment row when available.
  const judgmentResultId = rows[rows.length - 1]?.id ?? null;
  return { judgmentResultId };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let input: PushInput;
  try {
    input = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!input?.document_id) {
    return jsonResponse({ error: "document_id is required" }, 400);
  }

  try {
    const supabase = getSupabase();

    const { data: extracted, error: extractedError } = await supabase
      .from("extracted_fields")
      .select(
        "id, document_id, doc_type, vendor_raw, total_amount, invoice_date, confidence_scores, raw_ocr_json, ai_fallback_used",
      )
      .eq("document_id", input.document_id)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (extractedError) {
      throw new Error(`Failed to load extracted_fields: ${extractedError.message}`);
    }
    if (!extracted) {
      return jsonResponse(
        { error: "No extracted_fields row for document_id", document_id: input.document_id },
        404,
      );
    }

    let judgmentResultId: string | null = null;
    try {
      ({ judgmentResultId } = await assertJudgmentsPassed(
        supabase,
        input.document_id,
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(
        {
          ok: false,
          skipped: true,
          reason: "judgment_not_passed",
          error: message,
          document_id: input.document_id,
        },
        409,
      );
    }

    const vendors =
      input.vendors ??
      parseJsonEnv<ZohoVendor[]>("ZOHO_VENDORS_JSON") ??
      [];
    const accounts =
      input.accounts ??
      parseJsonEnv<ZohoAccount[]>("ZOHO_ACCOUNTS_JSON") ??
      [];

    if (vendors.length === 0 || accounts.length === 0) {
      return jsonResponse(
        {
          ok: false,
          skipped: true,
          reason: "missing_entity_cache",
          error:
            "Provide vendors/accounts in the request body or set ZOHO_VENDORS_JSON and ZOHO_ACCOUNTS_JSON",
          document_id: input.document_id,
        },
        400,
      );
    }

    const mapped = mapExtractedFieldsToZohoBill(extracted as ExtractedFieldsRow);
    const matched = matchEntities({
      bill: mapped,
      vendors,
      accounts,
      expense_category: input.expense_category,
    });

    if (matched.unresolved) {
      await supabase
        .from("documents")
        .update({ status: "needs_review" })
        .eq("id", input.document_id);

      return jsonResponse(
        {
          ok: false,
          skipped: true,
          reason: "entities_unresolved",
          unresolved_fields: matched.unresolved_fields,
          document_id: input.document_id,
        },
        409,
      );
    }

    const billBody = toZohoBillBody(matched.bill);
    const { externalDocId, raw, retried } = await pushBillWithRetry(billBody);

    const { data: syncRow, error: syncError } = await supabase
      .from("erp_sync_log")
      .insert({
        document_id: input.document_id,
        source_type: "push",
        erp_name: "zoho_books",
        external_doc_id: externalDocId,
        judgment_result_id: judgmentResultId,
      })
      .select("id")
      .single();

    if (syncError) {
      throw new Error(`erp_sync_log insert failed: ${syncError.message}`);
    }

    await supabase
      .from("documents")
      .update({ status: "synced" })
      .eq("id", input.document_id);

    return jsonResponse({
      ok: true,
      document_id: input.document_id,
      external_doc_id: externalDocId,
      erp_sync_log_id: syncRow.id,
      retried,
      zoho_response: raw,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("zoho-push failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
