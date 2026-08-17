// Authenticated approve → Zoho Books bill.
// Secrets come from Deno.env (local --env-file / hosted supabase secrets).
// Never returns a Zoho token. Always scopes the invoice by the caller's company.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";
import { createZohoMeter, meterContextFromRequest } from "../_shared/zoho_meter.ts";
import {
  mapExtractedFieldsToZohoBill,
  type ExtractedFieldsRow,
  type ExtractedLineItemRow,
} from "../zoho-push/mapping.ts";
import {
  matchEntities,
  type ZohoAccount,
  type ZohoVendor,
} from "../zoho-push/match-entities.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info, x-supabase-api-version, x-action-id, x-actor",
};

type PostAs = "bill" | "invoice" | "expense";

interface ApproveInput {
  invoice_id?: string;
  post_as?: PostAs;
  vendor_id?: string | null;
  customer_id?: string | null;
  account_id?: string | null;
  paid_through_account_id?: string | null;
  tax_treatment?: string | null;
  /**
   * Unused credit the reviewer chose to apply once the document exists
   * (advances = unused payments, credit notes / vendor credits). Applied
   * AFTER a successful create; a failure here never undoes the document —
   * it is reported in the response.
   */
  apply_credits?: Array<{
    kind: "customerpayment" | "creditnote" | "vendorpayment" | "vendorcredit";
    zoho_id: string;
    amount: number;
  }> | null;
}

interface ApproveResult {
  success: boolean;
  zoho_bill_id?: string;
  error?: string;
  credits_applied?: { applied: number; ok: boolean; response?: unknown } | null;
}

let zohoFetch: (url: string, init?: RequestInit) => Promise<Response> = fetch;

function jsonResponse(body: ApproveResult, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function apiBase(): string {
  return Deno.env.get("ZOHO_API_BASE_URL")?.trim() ||
    "https://www.zohoapis.com/books/v3";
}

function orgId(): string {
  return requireEnv("ZOHO_ORGANIZATION_ID");
}

function getServiceClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Strip anything that looks like a token before it leaves this function. */
function publicError(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  message = message.replace(
    /[0-9a-f]{20,}|1000\.[A-Za-z0-9._-]+|Zoho-oauthtoken\s+\S+/gi,
    "[redacted]",
  );
  return message.slice(0, 500);
}

function companyIdFromUser(user: User): string | null {
  const raw = user.app_metadata?.company_id;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return null;
}

async function callerFromRequest(
  req: Request,
): Promise<{ user: User; companyId: string } | Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return jsonResponse({ success: false, error: "Sign in required" }, 401);
  }

  const authClient = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) {
    return jsonResponse({ success: false, error: "Sign in required" }, 401);
  }
  const companyId = companyIdFromUser(data.user);
  if (!companyId) {
    return jsonResponse(
      { success: false, error: "No company_id on this account" },
      403,
    );
  }
  return { user: data.user, companyId };
}

async function writeAudit(
  supabase: SupabaseClient,
  row: {
    company_id: string;
    invoice_id: string;
    actor_id: string;
    action: "zoho_synced" | "zoho_sync_failed";
    detail: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.from("audit_log").insert({
    company_id: row.company_id,
    invoice_id: row.invoice_id,
    actor_type: "human",
    actor_id: row.actor_id,
    action: row.action,
    detail: row.detail,
  });
  if (error) {
    console.error("audit_log insert failed:", error.message);
  }
}

async function markDocument(
  supabase: SupabaseClient,
  invoiceId: string,
  companyId: string,
  patch: { status: string; zoho_bill_id?: string | null },
): Promise<void> {
  const { error } = await supabase
    .from("documents")
    .update(patch)
    .eq("id", invoiceId)
    .eq("company_id", companyId);
  if (error) {
    console.error("documents update failed:", error.message);
  }
}

async function cacheAccessToken(token: string): Promise<void> {
  try {
    await getServiceClient().from("zoho_oauth_tokens").upsert({
      id: 1,
      access_token: token,
      expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(
      "zoho_oauth_tokens cache write failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function refreshAccessToken(): Promise<string> {
  const clientId = requireEnv("ZOHO_CLIENT_ID");
  const clientSecret = requireEnv("ZOHO_CLIENT_SECRET");
  const refreshToken = requireEnv("ZOHO_REFRESH_TOKEN");
  const accountsUrl = Deno.env.get("ZOHO_ACCOUNTS_URL")?.trim() ||
    "https://accounts.zoho.com";

  const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const payload = await res.json();
  if (!res.ok || !payload?.access_token) {
    throw new Error(`Zoho token refresh failed (${res.status})`);
  }
  const token = String(payload.access_token);
  await cacheAccessToken(token);
  return token;
}

async function getAccessToken(): Promise<string> {
  const existing = Deno.env.get("ZOHO_ACCESS_TOKEN")?.trim();
  if (existing) return existing;
  try {
    const { data } = await getServiceClient()
      .from("zoho_oauth_tokens")
      .select("access_token, expires_at")
      .eq("id", 1)
      .maybeSingle();
    if (
      data?.access_token &&
      new Date(String(data.expires_at)).getTime() > Date.now() + 120_000
    ) {
      return String(data.access_token);
    }
  } catch {
    // Cache is optional.
  }
  return await refreshAccessToken();
}

type ZohoCallResult = { ok: boolean; status: number; raw: unknown };

async function withZohoRetry(
  call: (accessToken: string) => Promise<ZohoCallResult>,
): Promise<ZohoCallResult> {
  let token = await getAccessToken();
  let result = await call(token);
  if (
    !result.ok &&
    (result.status === 401 || result.status === 403 || result.status >= 500)
  ) {
    token = await refreshAccessToken();
    result = await call(token);
  }
  return result;
}

async function zohoCreate(
  path: "bills" | "invoices" | "expenses",
  body: Record<string, unknown>,
): Promise<{ id: string | null; result: ZohoCallResult }> {
  const result = await withZohoRetry(async (accessToken) => {
    const res = await zohoFetch(
      `${apiBase()}/${path}?organization_id=${encodeURIComponent(orgId())}`,
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, raw };
  });

  const raw = (result.raw ?? {}) as Record<string, unknown>;
  const root = (raw.bill ?? raw.invoice ?? raw.expense ?? raw) as Record<
    string,
    unknown
  >;
  const id = root.bill_id ?? root.invoice_id ?? root.expense_id ?? raw.bill_id;
  return { id: id != null ? String(id) : null, result };
}

/**
 * Apply unused credits to a freshly created invoice or bill.
 *   invoice: POST /invoices/{id}/credits { invoice_payments[], apply_creditnotes[] }
 *   bill:    POST /bills/{id}/credits    { bill_payments[], apply_vendor_credits[] }
 * Only what the reviewer ticked. Zoho refuses over-application; we surface it.
 */
async function applyCreditsToDoc(
  docKind: "invoice" | "bill",
  docId: string,
  credits: NonNullable<ApproveInput["apply_credits"]>,
): Promise<{ applied: number; ok: boolean; response?: unknown }> {
  const wanted = credits.filter((c) => c && c.zoho_id && Number(c.amount) > 0);
  if (!wanted.length) return { applied: 0, ok: true };
  const body: Record<string, unknown> = {};
  if (docKind === "invoice") {
    const pays = wanted.filter((c) => c.kind === "customerpayment").map((c) => ({ payment_id: c.zoho_id, amount_applied: Number(c.amount) }));
    const cns = wanted.filter((c) => c.kind === "creditnote").map((c) => ({ creditnote_id: c.zoho_id, amount_applied: Number(c.amount) }));
    if (pays.length) body.invoice_payments = pays;
    if (cns.length) body.apply_creditnotes = cns;
  } else {
    const pays = wanted.filter((c) => c.kind === "vendorpayment").map((c) => ({ payment_id: c.zoho_id, amount_applied: Number(c.amount) }));
    const vcs = wanted.filter((c) => c.kind === "vendorcredit").map((c) => ({ vendor_credit_id: c.zoho_id, amount_applied: Number(c.amount) }));
    if (pays.length) body.bill_payments = pays;
    if (vcs.length) body.apply_vendor_credits = vcs;
  }
  if (!Object.keys(body).length) return { applied: 0, ok: true };
  const result = await withZohoRetry(async (accessToken) => {
    const res = await zohoFetch(
      `${apiBase()}/${docKind === "invoice" ? "invoices" : "bills"}/${encodeURIComponent(docId)}/credits?organization_id=${encodeURIComponent(orgId())}`,
      { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok && (raw as { code?: number })?.code === 0, status: res.status, raw };
  });
  return { applied: result.ok ? wanted.reduce((t, c) => t + Number(c.amount), 0) : 0, ok: result.ok, response: result.raw };
}

async function loadCachedVendors(
  supabase: SupabaseClient,
): Promise<ZohoVendor[]> {
  const { data } = await supabase
    .from("zoho_entities")
    .select("zoho_id, name")
    .eq("kind", "vendor");
  return (data ?? []).map((r) => ({
    vendor_id: String(r.zoho_id),
    vendor_name: String(r.name),
  }));
}

async function loadCachedAccounts(
  supabase: SupabaseClient,
): Promise<ZohoAccount[]> {
  const { data } = await supabase
    .from("zoho_entities")
    .select("zoho_id, name, extra")
    .eq("kind", "account");
  return (data ?? []).map((r) => ({
    account_id: String(r.zoho_id),
    account_name: String(r.name),
    account_type: (r.extra as { account_type?: unknown } | null)?.account_type !=
        null
      ? String((r.extra as { account_type?: unknown }).account_type)
      : null,
  }));
}

async function lookupDefaultAccount(
  supabase: SupabaseClient,
  table: "vendor_account_rules" | "customer_account_rules",
  idColumn: "vendor_zoho_id" | "customer_zoho_id",
  entityZohoId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from(table)
    .select("account_zoho_id")
    .eq(idColumn, entityZohoId)
    .maybeSingle();
  return data?.account_zoho_id ? String(data.account_zoho_id) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const identity = await callerFromRequest(req);
  if (identity instanceof Response) return identity;
  const { user, companyId } = identity;

  let input: ApproveInput = {};
  try {
    const text = await req.text();
    input = text ? JSON.parse(text) as ApproveInput : {};
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  const invoiceId = input.invoice_id?.trim();
  if (!invoiceId) {
    return jsonResponse({ success: false, error: "invoice_id is required" }, 400);
  }

  const supabase = getServiceClient();
  const meter = createZohoMeter(supabase, {
    ...meterContextFromRequest(req, "push", "zoho-approve"),
    company_id: companyId,
    actor: user.email ?? user.id,
  });
  zohoFetch = meter.fetch;

  const fail = async (error: string, extra: Record<string, unknown> = {}) => {
    await markDocument(supabase, invoiceId, companyId, {
      status: "sync_failed",
    });
    await writeAudit(supabase, {
      company_id: companyId,
      invoice_id: invoiceId,
      actor_id: user.id,
      action: "zoho_sync_failed",
      detail: { error, ...extra },
    });
    return jsonResponse({ success: false, error }, 500);
  };

  try {
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("id, company_id, file_url, status")
      .eq("id", invoiceId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (docError) {
      return await fail(publicError(docError.message));
    }
    if (!doc) {
      return jsonResponse(
        { success: false, error: "Invoice not found for this company" },
        404,
      );
    }

    const { data: extracted, error: extractedError } = await supabase
      .from("extracted_fields")
      .select(
        "id, document_id, vendor_raw, total_amount, invoice_date, currency, tax_amount, invoice_number, due_date",
      )
      .eq("document_id", invoiceId)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (extractedError || !extracted) {
      return await fail(
        extractedError?.message ?? "No extracted fields for this invoice",
      );
    }

    const { data: lineRowsData } = await supabase
      .from("extracted_line_items")
      .select(
        "line_no, description, quantity, rate, amount, account_zoho_id, tax_zoho_id, project_zoho_id, reporting_tags",
      )
      .eq("extracted_fields_id", extracted.id)
      .order("line_no");
    const lineRows = (lineRowsData ?? []) as ExtractedLineItemRow[];

    const mapped = mapExtractedFieldsToZohoBill(
      extracted as ExtractedFieldsRow,
      lineRows,
    );
    const postAs: PostAs = input.post_as ?? "bill";

    let zohoId: string | null = null;

    if (postAs === "invoice") {
      const customerId = input.customer_id?.trim();
      if (!customerId) {
        return await fail("Select the Zoho customer this invoice belongs to.");
      }
      let accountId = input.account_id?.trim() || null;
      if (!accountId) {
        accountId = await lookupDefaultAccount(
          supabase,
          "customer_account_rules",
          "customer_zoho_id",
          customerId,
        );
      }
      const created = await zohoCreate("invoices", {
        customer_id: customerId,
        date: mapped.date,
        reference_number: mapped.invoice_number ||
          `DIC-${invoiceId.replace(/-/g, "").slice(0, 12)}`,
        ...(mapped.due_date ? { due_date: mapped.due_date } : {}),
        ...(input.tax_treatment?.trim()
          ? { tax_treatment: input.tax_treatment.trim() }
          : {}),
        line_items: mapped.line_items.map((li) => ({
          description: li.description,
          rate: li.rate,
          quantity: li.quantity,
          ...(li.account_id ?? accountId
            ? { account_id: li.account_id ?? accountId }
            : {}),
          ...(li.tax_id ? { tax_id: li.tax_id } : {}),
          ...(li.project_id ? { project_id: li.project_id } : {}),
          ...(li.tags?.length ? { tags: li.tags } : {}),
        })),
      });
      if (!created.result.ok || !created.id) {
        return await fail("Zoho invoice create failed", {
          status: created.result.status,
        });
      }
      zohoId = created.id;
    } else if (postAs === "expense") {
      let accountId = input.account_id?.trim() || null;
      if (!accountId && input.vendor_id?.trim()) {
        accountId = await lookupDefaultAccount(
          supabase,
          "vendor_account_rules",
          "vendor_zoho_id",
          input.vendor_id.trim(),
        );
      }
      const paidThrough = input.paid_through_account_id?.trim() ||
        Deno.env.get("ZOHO_PAID_THROUGH_ACCOUNT_ID")?.trim();
      if (!accountId || !paidThrough) {
        return await fail(
          "Expense needs an account and a paid-through bank/cash account.",
        );
      }
      const created = await zohoCreate("expenses", {
        account_id: accountId,
        paid_through_account_id: paidThrough,
        date: mapped.date,
        amount: mapped.line_items[0]?.rate,
        ...(input.vendor_id?.trim() ? { vendor_id: input.vendor_id.trim() } : {}),
        ...(input.tax_treatment?.trim()
          ? { tax_treatment: input.tax_treatment.trim() }
          : {}),
      });
      if (!created.result.ok || !created.id) {
        return await fail("Zoho expense create failed", {
          status: created.result.status,
        });
      }
      zohoId = created.id;
    } else {
      const vendors = await loadCachedVendors(supabase);
      const accounts = await loadCachedAccounts(supabase);
      let matched = matchEntities({
        bill: mapped,
        vendors,
        accounts,
        expense_category: null,
      });

      matched = {
        ...matched,
        bill: {
          ...matched.bill,
          line_items: matched.bill.line_items.map((item, i) => ({
            ...item,
            ...(mapped.line_items[i]?.account_id
              ? { account_id: mapped.line_items[i].account_id }
              : {}),
            ...(mapped.line_items[i]?.tax_id
              ? { tax_id: mapped.line_items[i].tax_id }
              : {}),
            ...(mapped.line_items[i]?.project_id
              ? { project_id: mapped.line_items[i].project_id }
              : {}),
            ...(mapped.line_items[i]?.tags?.length
              ? { tags: mapped.line_items[i].tags }
              : {}),
          })),
        },
      };

      if (input.vendor_id?.trim()) {
        matched = {
          ...matched,
          unresolved_fields: matched.unresolved_fields.filter((f) =>
            f !== "vendor"
          ),
          bill: { ...matched.bill, vendor_id: input.vendor_id.trim() },
        };
        matched.unresolved = matched.unresolved_fields.length > 0;
      }

      if (input.account_id?.trim()) {
        const chosen = input.account_id.trim();
        matched = {
          ...matched,
          unresolved_fields: matched.unresolved_fields.filter((f) =>
            f !== "account"
          ),
          bill: {
            ...matched.bill,
            line_items: matched.bill.line_items.map((item) =>
              item.account_id ? item : { ...item, account_id: chosen }
            ),
          },
        };
        matched.unresolved = matched.unresolved_fields.length > 0;
      }

      if (!input.account_id?.trim() && matched.bill.vendor_id) {
        const ruleId = await lookupDefaultAccount(
          supabase,
          "vendor_account_rules",
          "vendor_zoho_id",
          matched.bill.vendor_id,
        );
        if (ruleId) {
          matched = {
            ...matched,
            unresolved_fields: matched.unresolved_fields.filter((f) =>
              f !== "account"
            ),
            bill: {
              ...matched.bill,
              line_items: matched.bill.line_items.map((item) =>
                item.account_id ? item : { ...item, account_id: ruleId }
              ),
            },
          };
          matched.unresolved = matched.unresolved_fields.length > 0;
        }
      }

      const missingAccount = matched.bill.line_items.some((li) => !li.account_id);
      const missingVendor = !matched.bill.vendor_id;
      if (missingVendor || missingAccount) {
        return await fail(
          "Pick the vendor and account in review before approving.",
          { missing_vendor: missingVendor, missing_account: missingAccount },
        );
      }

      const billNumber = mapped.invoice_number?.trim() ||
        `DIC-${invoiceId.replace(/-/g, "").slice(0, 12)}`;
      const created = await zohoCreate("bills", {
        vendor_id: matched.bill.vendor_id,
        bill_number: billNumber,
        date: mapped.date,
        ...(mapped.due_date ? { due_date: mapped.due_date } : {}),
        ...(mapped.reference_number
          ? { reference_number: mapped.reference_number }
          : {}),
        ...(input.tax_treatment?.trim()
          ? { tax_treatment: input.tax_treatment.trim() }
          : {}),
        line_items: matched.bill.line_items.map((item) => ({
          description: item.description,
          rate: item.rate,
          quantity: item.quantity,
          account_id: item.account_id,
          ...(item.tax_id ? { tax_id: item.tax_id } : {}),
          ...(item.project_id ? { project_id: item.project_id } : {}),
          ...(item.tags?.length ? { tags: item.tags } : {}),
        })),
      });
      if (!created.result.ok || !created.id) {
        return await fail("Zoho bill create failed", {
          status: created.result.status,
        });
      }
      zohoId = created.id;
    }

    await markDocument(supabase, invoiceId, companyId, {
      status: "synced",
      zoho_bill_id: zohoId,
    });
    await supabase.from("erp_sync_log").insert({
      document_id: invoiceId,
      source_type: "push",
      erp_name: "zoho_books",
      external_doc_id: zohoId,
      // bills | invoices | expenses — expenses paid through a bank count as
      // "already recorded" for the statement flow.
      external_kind: postAs === "invoice" ? "invoices" : postAs === "expense" ? "expenses" : "bills",
    });

    // Reviewer chose to apply unused credit (advance / credit note / vendor
    // credit) to this invoice or bill. Best-effort, after the document
    // exists; reported, never fatal.
    let creditsApplied: ApproveResult["credits_applied"] = null;
    if (zohoId && postAs !== "expense" && input.apply_credits?.length) {
      try {
        creditsApplied = await applyCreditsToDoc(postAs === "invoice" ? "invoice" : "bill", zohoId, input.apply_credits);
      } catch (err) {
        creditsApplied = { applied: 0, ok: false, response: publicError(err) };
      }
    }
    await writeAudit(supabase, {
      company_id: companyId,
      invoice_id: invoiceId,
      actor_id: user.id,
      action: "zoho_synced",
      detail: { zoho_bill_id: zohoId, post_as: postAs, credits_applied: creditsApplied?.applied ?? 0 },
    });

    return jsonResponse({ success: true, zoho_bill_id: zohoId ?? undefined, credits_applied: creditsApplied });
  } catch (err) {
    return await fail(publicError(err));
  }
});
