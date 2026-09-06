// Push a human-approved invoice bill to Zoho Books (sandbox org via env).
// Uses existing OAuth refresh + single retry. Never hardcode credentials.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createZohoMeter, meterContextFromRequest } from "../_shared/zoho_meter.ts";
import { isAuthFail, requireUser } from "../_shared/require_user.ts";

/** Set per request; every Zoho call goes through it so usage is metered. */
let zohoFetch: (url: string, init?: RequestInit) => Promise<Response> = fetch;
import {
  mapExtractedFieldsToZohoBill,
  type ExtractedFieldsRow,
  type ExtractedLineItemRow,
  type ZohoBillMapped,
} from "./mapping.ts";
import {
  matchEntities,
  type ZohoAccount,
  type ZohoVendor,
} from "./match-entities.ts";
import { companyForCaller, isCompanyFail } from "../_shared/tenant.ts";
import { zohoAuthFor, type ZohoAuth } from "../_shared/zoho_auth.ts";

interface PushInput {
  document_id: string;
  /** Optional expense category hint for GL matching. */
  expense_category?: string | null;
  /** Cached Zoho vendors; falls back to ZOHO_VENDORS_JSON env or live API. */
  vendors?: ZohoVendor[];
  /** Cached chart of accounts; falls back to ZOHO_ACCOUNTS_JSON env or live API. */
  accounts?: ZohoAccount[];
  /** How to post into Zoho Books; defaults to "bill". */
  post_as?: "bill" | "invoice" | "expense";
  /** Explicit Zoho vendor contact id chosen in the review UI (bill/expense). */
  vendor_id?: string | null;
  /** Explicit Zoho customer contact id chosen in the review UI (invoice). */
  customer_id?: string | null;
  /** Explicit GL account id chosen in the review UI. */
  account_id?: string | null;
  /** Bank/cash account the expense was paid through (expense only). */
  paid_through_account_id?: string | null;
  /**
   * Unused credit the reviewer chose to apply once the document exists:
   * advances (unused customer/vendor payments) and credit notes / vendor
   * credits. Applied AFTER a successful create; a failure here never undoes
   * the document — it is reported in the response instead.
   */
  apply_credits?: Array<{
    kind: "customerpayment" | "creditnote" | "vendorpayment" | "vendorcredit";
    zoho_id: string;
    amount: number;
  }> | null;
  /**
   * VAT treatment for THIS transaction (e.g. vat_registered, out_of_scope).
   * Treatment is transactional, not just party-level — a VAT-registered
   * vendor can still have an out-of-scope bill. When omitted, Zoho applies
   * the contact's own default treatment.
   */
  tax_treatment?: string | null;
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

interface DefaultAccountRule {
  account_zoho_id: string;
  account_name: string;
}

/**
 * Per-party default account rule ("if vendor/customer is X, post to
 * account Y"). Returns null when no rule exists — there is deliberately
 * no global default account.
 */
async function lookupDefaultAccountRule(
  supabase: SupabaseClient,
  table: "vendor_account_rules" | "customer_account_rules",
  idColumn: "vendor_zoho_id" | "customer_zoho_id",
  entityZohoId: string,
): Promise<DefaultAccountRule | null> {
  const { data, error } = await supabase
    .from(table)
    .select("account_zoho_id, account_name")
    .eq(idColumn, entityZohoId)
    .maybeSingle();
  if (error) {
    console.log(`${table} lookup failed: ${error.message}`);
    return null;
  }
  return (data as DefaultAccountRule | null) ?? null;
}

/**
 * Resolve the document's currency code and VAT amount against the synced
 * zoho_entities cache. VAT sits in Zoho's tax field, never inside the line
 * amount: when a tax rate matches, the line becomes the NET amount plus a
 * tax_id, so Zoho recomputes the same gross total the invoice shows.
 */
async function resolveCurrencyAndTax(
  supabase: SupabaseClient,
  currencyCode: string | null | undefined,
  grossAmount: number,
  taxAmount: number | null | undefined,
): Promise<{
  currencyId: string | null;
  taxId: string | null;
  taxName: string | null;
  netRate: number | null;
  notes: string[];
}> {
  const notes: string[] = [];
  let currencyId: string | null = null;
  let taxId: string | null = null;
  let taxName: string | null = null;
  let netRate: number | null = null;

  if (currencyCode) {
    const { data } = await supabase
      .from("zoho_entities")
      .select("zoho_id")
      .eq("kind", "currency")
      .eq("name", currencyCode)
      .maybeSingle();
    if (data?.zoho_id) {
      currencyId = String(data.zoho_id);
    } else {
      notes.push(
        `currency ${currencyCode} not in synced Zoho currencies — Zoho default applies`,
      );
    }
  }

  if (taxAmount != null && taxAmount >= 0 && grossAmount > taxAmount) {
    const net = grossAmount - taxAmount;
    const pct = (taxAmount / net) * 100;
    const { data: taxes } = await supabase
      .from("zoho_entities")
      .select("zoho_id, name, extra")
      .eq("kind", "tax");
    const match = (taxes ?? []).find((t) => {
      const p = Number((t.extra as { percentage?: unknown })?.percentage);
      return Number.isFinite(p) && Math.abs(p - pct) <= 0.5;
    });
    if (match) {
      taxId = String(match.zoho_id);
      taxName = String(match.name);
      netRate = Math.round(net * 100) / 100;
    } else {
      notes.push(
        `VAT ${taxAmount} on ${grossAmount} (~${pct.toFixed(1)}%) matches no synced Zoho tax rate — posted gross without tax_id`,
      );
    }
  }

  return { currencyId, taxId, taxName, netRate, notes };
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



function toZohoBillBody(
  bill: ZohoBillMapped,
  opts?: { billNumber?: string },
): Record<string, unknown> {
  if (!bill.vendor_id) {
    throw new Error("vendor_id is required before Zoho push");
  }
  for (const item of bill.line_items) {
    if (!item.account_id) {
      throw new Error("account_id is required on line items before Zoho push");
    }
  }

  // Many Zoho orgs (esp. India) require an explicit bill_number when
  // auto-generation is off — omit/invalid values return code 4.
  const billNumber = (opts?.billNumber ?? "").trim() ||
    `DIC-${Date.now()}`;

  return {
    vendor_id: bill.vendor_id,
    bill_number: billNumber,
    date: bill.date,
    ...(bill.due_date ? { due_date: bill.due_date } : {}),
    ...(bill.reference_number
      ? { reference_number: bill.reference_number }
      : {}),
    line_items: bill.line_items.map((item) => ({
      description: item.description,
      rate: item.rate,
      quantity: item.quantity,
      account_id: item.account_id,
      ...(item.tax_id ? { tax_id: item.tax_id } : {}),
      ...(item.project_id ? { project_id: item.project_id } : {}),
      ...(item.tags && item.tags.length > 0 ? { tags: item.tags } : {}),
    })),
  };
}

/** Find an existing bill by number + vendor (for idempotent creates). */
async function findBillByNumber(
  z: ZohoAuth,
  billNumber: string,
  vendorId: string,
): Promise<ZohoCallResult> {
  const url = `${z.apiBase}/bills?organization_id=${
    encodeURIComponent(z.organizationId)
  }&bill_number=${encodeURIComponent(billNumber)}&vendor_id=${
    encodeURIComponent(vendorId)
  }`;
  const res = await zohoFetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
  });
  const raw = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, raw };
  const bill = (raw as { bills?: Array<{ bill_id?: unknown }> })?.bills?.[0];
  return bill?.bill_id
    ? { ok: true, status: 200, raw: String(bill.bill_id) }
    : { ok: false, status: 404, raw: null };
}


/**
 * The calling company's own Zoho organisation and a token for it. This used
 * to read ZOHO_REFRESH_TOKEN and ZOHO_ORGANIZATION_ID from the environment,
 * which is one organisation for the whole deployment — see
 * _shared/zoho_auth.ts, which also holds the token cache, now per company.
 */
async function getZoho(companyId: string): Promise<ZohoAuth> {
  return await zohoAuthFor(getSupabase(), companyId);
}

type ZohoCallResult = {
  ok: boolean;
  status: number;
  raw: unknown;
};

/**
 * Run a Zoho HTTP call; on 401/403/5xx refresh token and retry once.
 */
async function withZohoRetry(
  companyId: string,
  call: (z: ZohoAuth) => Promise<ZohoCallResult>,
): Promise<{ result: ZohoCallResult; z: ZohoAuth; retried: boolean }> {
  let z = await getZoho(companyId);
  let retried = false;
  let result = await call(z);

  if (!result.ok) {
    const shouldRetry =
      result.status === 401 ||
      result.status === 403 ||
      result.status >= 500;
    if (shouldRetry) {
      console.log(
        `Zoho call failed (${result.status}); refreshing token and retrying once`,
      );
      // A cached token can be revoked before it expires; ask for a new one.
      z = await zohoAuthFor(getSupabase(), companyId, { forceRefresh: true });
      retried = true;
      result = await call(z);
    }
  }

  return { result, z, retried };
}

async function createZohoBill(
  z: ZohoAuth,
  billBody: Record<string, unknown>,
): Promise<ZohoCallResult & { externalDocId?: string }> {
  const url =
    `${z.apiBase}/bills?organization_id=${encodeURIComponent(z.organizationId)}`;
  const res = await zohoFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${z.accessToken}`,
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

async function attachBillDocument(
  z: ZohoAuth,
  billId: string,
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): Promise<ZohoCallResult> {
  const form = new FormData();
  form.append(
    "attachment",
    new Blob([bytes], { type: contentType || "application/pdf" }),
    filename || "invoice.pdf",
  );

  const url =
    `${z.apiBase}/bills/${encodeURIComponent(billId)}/attachment?organization_id=${
      encodeURIComponent(z.organizationId)
    }`;
  const res = await zohoFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${z.accessToken}`,
    },
    body: form,
  });
  const raw = await res.json().catch(async () => await res.text());
  return { ok: res.ok, status: res.status, raw };
}

async function getZohoBill(
  z: ZohoAuth,
  billId: string,
): Promise<ZohoCallResult> {
  const url =
    `${z.apiBase}/bills/${encodeURIComponent(billId)}?organization_id=${
      encodeURIComponent(z.organizationId)
    }`;
  const res = await zohoFetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
  });
  const raw = await res.json().catch(async () => await res.text());
  return { ok: res.ok, status: res.status, raw };
}

/** Create an invoice or expense in Zoho Books; extracts the created doc id. */
/**
 * Apply unused credits to a freshly created invoice or bill.
 *   invoice: POST /invoices/{id}/credits  { invoice_payments[], apply_creditnotes[] }
 *   bill:    POST /bills/{id}/credits     { bill_payments[], apply_vendor_credits[] }
 * Only what the reviewer picked; never more than the credit's balance was
 * shown to hold. Zoho refuses over-application, and we surface its message.
 */
async function applyCreditsToDoc(
  z: ZohoAuth,
  docKind: "invoice" | "bill",
  docId: string,
  credits: NonNullable<PushInput["apply_credits"]>,
): Promise<{ applied: number; results: Array<Record<string, unknown>> }> {
  const results: Array<Record<string, unknown>> = [];
  let applied = 0;
  const wanted = credits.filter((c) => c && c.zoho_id && Number(c.amount) > 0);
  if (!wanted.length) return { applied, results };
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
  if (!Object.keys(body).length) return { applied, results };
  const url = `${z.apiBase}/${docKind === "invoice" ? "invoices" : "bills"}/${encodeURIComponent(docId)}/credits?organization_id=${encodeURIComponent(z.organizationId)}`;
  const res = await zohoFetch(url, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.json().catch(async () => await res.text());
  const ok = res.ok && (raw as { code?: number })?.code === 0;
  if (ok) applied = wanted.reduce((t, c) => t + Number(c.amount), 0);
  results.push({ ok, status: res.status, body, response: raw });
  return { applied, results };
}

async function createZohoDoc(
  z: ZohoAuth,
  path: "invoices" | "expenses",
  body: Record<string, unknown>,
  rootKey: "invoice" | "expense",
  idKey: "invoice_id" | "expense_id",
): Promise<ZohoCallResult & { externalDocId?: string }> {
  const url = `${z.apiBase}/${path}?organization_id=${
    encodeURIComponent(z.organizationId)
  }`;
  const res = await zohoFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${z.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await res.json().catch(async () => await res.text());
  if (!res.ok) {
    return { ok: false, status: res.status, raw };
  }

  const root = (raw as Record<string, unknown>)?.[rootKey] as
    | Record<string, unknown>
    | undefined;
  const id = root?.[idKey];
  return {
    ok: true,
    status: res.status,
    externalDocId: id != null ? String(id) : undefined,
    raw,
  };
}

/** Attach the source file to an invoice (attachment) or expense (receipt). */
async function attachToZohoDoc(
  z: ZohoAuth,
  urlPath: string,
  fieldName: "attachment" | "receipt",
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): Promise<ZohoCallResult> {
  const form = new FormData();
  form.append(
    fieldName,
    new Blob([bytes], { type: contentType || "application/pdf" }),
    filename || "document.pdf",
  );
  const url = `${z.apiBase}/${urlPath}?organization_id=${
    encodeURIComponent(z.organizationId)
  }`;
  const res = await zohoFetch(url, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
    body: form,
  });
  const raw = await res.json().catch(async () => await res.text());
  return { ok: res.ok, status: res.status, raw };
}

async function fetchVendorsFromZoho(
  z: ZohoAuth,
): Promise<ZohoVendor[]> {
  const url =
    `${z.apiBase}/contacts?organization_id=${encodeURIComponent(z.organizationId)}&contact_type=vendor&per_page=200`;
  const res = await zohoFetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
  });
  const raw = await res.json();
  if (!res.ok) {
    throw new Error(
      `Zoho vendors fetch failed (${res.status}): ${JSON.stringify(raw)}`,
    );
  }
  const contacts = (raw as { contacts?: Array<Record<string, unknown>> })
    ?.contacts ?? [];
  return contacts.map((c) => ({
    vendor_id: String(c.contact_id ?? c.vendor_id ?? ""),
    vendor_name: String(c.contact_name ?? c.vendor_name ?? ""),
  })).filter((v) => v.vendor_id && v.vendor_name);
}

async function fetchAccountsFromZoho(
  z: ZohoAuth,
): Promise<ZohoAccount[]> {
  const url =
    `${z.apiBase}/chartofaccounts?organization_id=${encodeURIComponent(z.organizationId)}&per_page=200`;
  const res = await zohoFetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
  });
  const raw = await res.json();
  if (!res.ok) {
    throw new Error(
      `Zoho chart of accounts fetch failed (${res.status}): ${JSON.stringify(raw)}`,
    );
  }
  const accounts = (raw as { chartofaccounts?: Array<Record<string, unknown>> })
    ?.chartofaccounts ?? [];
  return accounts.map((a) => ({
    account_id: String(a.account_id ?? ""),
    account_name: String(a.account_name ?? ""),
    account_type: a.account_type != null ? String(a.account_type) : null,
  })).filter((a) => a.account_id && a.account_name);
}


async function loadDocumentBytes(
  supabase: SupabaseClient,
  fileUrl: string,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  const publicMarker = "/storage/v1/object/public/invoices/";
  const publicIdx = fileUrl.indexOf(publicMarker);
  if (publicIdx >= 0) {
    const path = decodeURIComponent(
      fileUrl.slice(publicIdx + publicMarker.length),
    );
    const { data, error } = await supabase.storage.from("invoices").download(
      path,
    );
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

async function assertHumanApproved(
  supabase: SupabaseClient,
  documentId: string,
): Promise<void> {
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, status")
    .eq("id", documentId)
    .single();
  if (error || !doc) {
    throw new Error(`Document not found: ${error?.message ?? documentId}`);
  }
  if (doc.status !== "approved") {
    throw new Error(
      `Document must be human-approved before Zoho push (status=${doc.status})`,
    );
  }
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

  const judgmentResultId = rows[rows.length - 1]?.id ?? null;
  return { judgmentResultId };
}

function attachmentPresent(billRaw: unknown): {
  present: boolean;
  documents: unknown[];
} {
  const bill = (billRaw as { bill?: Record<string, unknown> })?.bill ??
    (billRaw as Record<string, unknown>);
  const docs = (bill?.documents as unknown[]) ??
    (bill?.document as unknown[]) ??
    [];
  const list = Array.isArray(docs) ? docs : docs ? [docs] : [];
  const name = bill?.attachment_name ?? bill?.file_name;
  return {
    present: list.length > 0 || Boolean(name),
    documents: list,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, content-type, apikey, x-client-info",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const auth = await requireUser(req);
  if (isAuthFail(auth)) return auth.response;

  let input: PushInput;
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
  const companyId = tenant.companyId;
  // Resolved here rather than inside the bill branch: the sync-log payloads
  // record which Zoho organisation was posted to, and they are written from
  // branches that never enter it.
  let zAuth = await getZoho(companyId);

  try {
    const supabase = getSupabase();
    const meter = createZohoMeter(
      supabase,
      meterContextFromRequest(req, "push", "zoho-push"),
    );
    zohoFetch = meter.fetch;

    try {
      await assertHumanApproved(supabase, input.document_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(
        {
          ok: false,
          skipped: true,
          reason: "not_human_approved",
          error: message,
          document_id: input.document_id,
        },
        409,
      );
    }

    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("id, file_url, status")
      .eq("id", input.document_id)
      .single();
    if (docError || !doc) {
      throw new Error(`Document not found: ${docError?.message ?? input.document_id}`);
    }

    const { data: extracted, error: extractedError } = await supabase
      .from("extracted_fields")
      .select(
        "id, document_id, doc_type, vendor_raw, total_amount, invoice_date, currency, tax_amount, invoice_number, due_date, confidence_scores, raw_ocr_json, ai_fallback_used",
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
        {
          error: "No extracted_fields row for document_id",
          document_id: input.document_id,
        },
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

    const postAs: "bill" | "invoice" | "expense" = input.post_as ?? "bill";
    // Reviewer-curated line items (with per-line accounts) when present.
    const { data: lineRowsData } = await supabase
      .from("extracted_line_items")
      .select(
        "line_no, description, quantity, rate, amount, account_zoho_id, tax_zoho_id, project_zoho_id, reporting_tags",
      )
      .eq("extracted_fields_id", (extracted as { id: string }).id)
      .order("line_no");
    const lineRows = (lineRowsData ?? []) as ExtractedLineItemRow[];
    const hasRealLines = lineRows.length > 0;

    // Reporting-tag consistency guard. A tag Zoho applies PER TRANSACTION
    // must carry ONE value across every line; the review UI cannot produce
    // a conflict, but data can arrive other ways, so refuse here rather
    // than send Zoho something it will either reject or silently reduce.
    if (hasRealLines) {
      const { data: tagRows } = await supabase
        .from("zoho_entities")
        .select("zoho_id, name, extra")
        .eq("kind", "reporting_tag");
      const txnLevel = new Map<string, string>();
      for (const t of tagRows ?? []) {
        if ((t.extra as { preference?: unknown } | null)?.preference === "transaction") {
          txnLevel.set(String(t.zoho_id), String(t.name));
        }
      }
      if (txnLevel.size > 0) {
        const seen = new Map<string, Set<string>>();
        for (const li of lineRows) {
          for (const tg of li.reporting_tags ?? []) {
            if (!tg?.tag_id || !tg?.tag_option_id || !txnLevel.has(tg.tag_id)) continue;
            const set = seen.get(tg.tag_id) ?? new Set<string>();
            set.add(tg.tag_option_id);
            seen.set(tg.tag_id, set);
          }
        }
        const conflicts = [...seen.entries()].filter(([, opts]) => opts.size > 1);
        if (conflicts.length > 0) {
          return jsonResponse(
            {
              ok: false,
              skipped: true,
              reason: "reporting_tag_conflict",
              error:
                `Reporting tag(s) ${conflicts.map(([id]) => `"${txnLevel.get(id)}"`).join(", ")} ` +
                `are set per transaction in Zoho Books, but the line items carry different values. ` +
                `Choose one value for the whole document.`,
              conflicts: conflicts.map(([id, opts]) => ({
                tag_id: id,
                tag_name: txnLevel.get(id),
                option_ids: [...opts],
              })),
              document_id: input.document_id,
            },
            400,
          );
        }
        // Consistent: make sure the single value is present on EVERY line
        // (a line without it would otherwise be un-tagged in Zoho).
        for (const [tagId, opts] of seen) {
          const only = [...opts][0];
          for (const li of lineRows) {
            const tags = (li.reporting_tags ?? []) as Array<{ tag_id: string; tag_option_id: string }>;
            if (!tags.some((t) => t.tag_id === tagId)) {
              li.reporting_tags = [...tags, { tag_id: tagId, tag_option_id: only }];
            }
          }
        }
      }
    }

    const mapped = mapExtractedFieldsToZohoBill(
      extracted as ExtractedFieldsRow,
      lineRows,
    );
    const grossTotal = Number(
      String((extracted as ExtractedFieldsRow).total_amount).replace(/,/g, ""),
    );
    const referenceNumber = `DIC-${
      input.document_id.replace(/-/g, "").slice(0, 12)
    }`;

    // ------------------------------------------------------------------
    // Invoice / expense paths: entity ids come from the review UI, so no
    // fuzzy matching or cache loading is needed.
    // ------------------------------------------------------------------
    if (postAs === "invoice" || postAs === "expense") {
      let createBody: Record<string, unknown>;
      let path: "invoices" | "expenses";
      let rootKey: "invoice" | "expense";
      let idKey: "invoice_id" | "expense_id";

      if (postAs === "invoice") {
        if (!input.customer_id?.trim()) {
          return jsonResponse(
            {
              ok: false,
              skipped: true,
              reason: "customer_required",
              error: "Select the Zoho customer this invoice belongs to.",
              document_id: input.document_id,
            },
            400,
          );
        }
        // Income account: explicit UI choice, else this customer's default
        // rule; otherwise Zoho's own income account default applies.
        let invoiceAccountId = input.account_id?.trim() || null;
        if (!invoiceAccountId) {
          const rule = await lookupDefaultAccountRule(
            supabase,
            "customer_account_rules",
            "customer_zoho_id",
            input.customer_id.trim(),
          );
          if (rule) invoiceAccountId = rule.account_zoho_id;
        }
        path = "invoices";
        rootKey = "invoice";
        idKey = "invoice_id";
        const invoiceMoney = await resolveCurrencyAndTax(
          supabase,
          mapped.currency,
          grossTotal,
          mapped.tax_amount,
        );
        createBody = {
          customer_id: input.customer_id.trim(),
          date: mapped.date,
          // Zoho owns the sales-invoice numbering sequence, so the
          // document's own number goes to reference_number (kept
          // searchable) rather than fighting invoice_number.
          reference_number: mapped.invoice_number || referenceNumber,
          ...(mapped.due_date ? { due_date: mapped.due_date } : {}),
          ...(input.tax_treatment?.trim()
            ? { tax_treatment: input.tax_treatment.trim() }
            : {}),
          ...(invoiceMoney.currencyId
            ? { currency_id: invoiceMoney.currencyId }
            : {}),
          // Real extracted lines when present (each with its own account /
          // tax, falling back to the transaction-level choices); else one
          // implicit line — net + tax_id when VAT matched, else the gross.
          line_items: hasRealLines
            ? mapped.line_items.map((li) => ({
              description: li.description,
              rate: li.rate,
              quantity: li.quantity,
              ...(li.tax_id ?? invoiceMoney.taxId
                ? { tax_id: li.tax_id ?? invoiceMoney.taxId }
                : {}),
              ...(li.account_id ?? invoiceAccountId
                ? { account_id: li.account_id ?? invoiceAccountId }
                : {}),
              ...(li.project_id ? { project_id: li.project_id } : {}),
              ...(li.tags?.length ? { tags: li.tags } : {}),
            }))
            : [
              {
                description: mapped.vendor_name
                  ? `Invoice — ${mapped.vendor_name}`
                  : "Imported invoice",
                rate: invoiceMoney.taxId && invoiceMoney.netRate != null
                  ? invoiceMoney.netRate
                  : mapped.line_items[0].rate,
                quantity: 1,
                ...(invoiceMoney.taxId ? { tax_id: invoiceMoney.taxId } : {}),
                ...(invoiceAccountId ? { account_id: invoiceAccountId } : {}),
              },
            ],
        };
      } else {
        // Account: explicit UI choice, else this vendor's default rule.
        // No global default account.
        let expenseAccountId = input.account_id?.trim() || null;
        if (!expenseAccountId && input.vendor_id?.trim()) {
          const rule = await lookupDefaultAccountRule(
            supabase,
            "vendor_account_rules",
            "vendor_zoho_id",
            input.vendor_id.trim(),
          );
          if (rule) expenseAccountId = rule.account_zoho_id;
        }
        if (!expenseAccountId) {
          return jsonResponse(
            {
              ok: false,
              skipped: true,
              reason: "account_required",
              error:
                "Select the expense account, or save a default account rule for this vendor.",
              document_id: input.document_id,
            },
            400,
          );
        }
        const paidThrough = input.paid_through_account_id?.trim() ||
          Deno.env.get("ZOHO_PAID_THROUGH_ACCOUNT_ID")?.trim();
        if (!paidThrough) {
          return jsonResponse(
            {
              ok: false,
              skipped: true,
              reason: "paid_through_required",
              error:
                "Select the bank/cash account this expense was paid through.",
              document_id: input.document_id,
            },
            400,
          );
        }
        path = "expenses";
        rootKey = "expense";
        idKey = "expense_id";
        createBody = {
          account_id: expenseAccountId,
          paid_through_account_id: paidThrough,
          date: mapped.date,
          amount: mapped.line_items[0].rate,
          reference_number: referenceNumber,
          ...(input.tax_treatment?.trim()
            ? { tax_treatment: input.tax_treatment.trim() }
            : {}),
          description: mapped.vendor_name
            ? `Expense — ${mapped.vendor_name}`
            : "Imported expense",
          ...(input.vendor_id?.trim()
            ? { vendor_id: input.vendor_id.trim() }
            : {}),
        };
      }

      const { result: createResult, retried: createRetried } =
        await withZohoRetry(companyId, (z) =>
          createZohoDoc(z, path, createBody, rootKey, idKey)
        );

      if (
        !createResult.ok || !("externalDocId" in createResult) ||
        !createResult.externalDocId
      ) {
        throw new Error(
          `Zoho ${rootKey} create failed (${createResult.status}): ${
            JSON.stringify(createResult.raw)
          }`,
        );
      }
      const externalDocId =
        (createResult as { externalDocId: string }).externalDocId;

      // Record the sync before the attachment upload so a failed upload
      // cannot lead to a duplicate document on re-push.
      const { data: syncRow, error: syncError } = await supabase
        .from("erp_sync_log")
        .insert({
          document_id: input.document_id,
          source_type: "push",
          erp_name: "zoho_books",
          external_doc_id: externalDocId,
          external_kind: path,
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

      // Reviewer chose to apply unused credit (advance / credit note) to
      // this invoice: do it now that it exists. Best-effort, reported.
      let creditsApplied: { applied: number; results: Array<Record<string, unknown>> } | null = null;
      if (postAs === "invoice" && input.apply_credits?.length) {
        try {
          const { result: cr } = await withZohoRetry(companyId, async (z) => {
            const r = await applyCreditsToDoc(z, "invoice", externalDocId, input.apply_credits!);
            creditsApplied = r;
            return { ok: r.results.every((x) => x.ok), status: 200, raw: r } as ZohoCallResult;
          });
          void cr;
        } catch (err) {
          creditsApplied = { applied: 0, results: [{ ok: false, error: err instanceof Error ? err.message : String(err) }] };
        }
      }

      // Best-effort attachment; the Zoho document already exists either way.
      let attachOk = false;
      let attachRaw: unknown = null;
      let filename = "";
      try {
        const file = await loadDocumentBytes(supabase, doc.file_url as string);
        filename = file.filename;
        const attachPath = postAs === "invoice"
          ? `invoices/${encodeURIComponent(externalDocId)}/attachment`
          : `expenses/${encodeURIComponent(externalDocId)}/receipt`;
        const { result: attachResult } = await withZohoRetry(companyId, (z) =>
          attachToZohoDoc(
            z,
            attachPath,
            postAs === "invoice" ? "attachment" : "receipt",
            file.bytes,
            file.contentType,
            file.filename,
          )
        );
        attachOk = attachResult.ok;
        attachRaw = attachResult.raw;
      } catch (attachErr) {
        attachRaw = {
          error: attachErr instanceof Error
            ? attachErr.message
            : String(attachErr),
        };
      }

      return jsonResponse({
        ok: true,
        post_as: postAs,
        document_id: input.document_id,
        external_doc_id: externalDocId,
        erp_sync_log_id: syncRow.id,
        sandbox_organization_id: zAuth.organizationId,
        retried: createRetried,
        credits_applied: creditsApplied,
        attachment: {
          uploaded: attachOk,
          filename,
          attach_response: attachRaw,
        },
        [postAs === "invoice" ? "zoho_invoice" : "zoho_expense"]:
          createResult.raw,
      });
    }

    // ------------------------------------------------------------------
    // Bill path (default) — fuzzy matching with optional UI overrides.
    // ------------------------------------------------------------------

    let vendors =
      input.vendors ??
      parseJsonEnv<ZohoVendor[]>("ZOHO_VENDORS_JSON") ??
      [];
    let accounts =
      input.accounts ??
      parseJsonEnv<ZohoAccount[]>("ZOHO_ACCOUNTS_JSON") ??
      [];

    // Account defaults come from per-vendor rules (vendor_account_rules) or
    // the caller's explicit choice — never from a global env default.
    // input.expense_category stays supported as a per-request matching hint.
    const expenseCategory = input.expense_category ?? null;
    const defaultVendorId = Deno.env.get("ZOHO_DEFAULT_VENDOR_ID")?.trim();

    // Fast path: with an explicit account we can skip chart-of-accounts fetch.
    const needAccounts = accounts.length === 0 && !input.account_id?.trim();
    const needVendors = vendors.length === 0 && !defaultVendorId;

    if (needVendors || needAccounts) {
      const { result: tokenProbe, z: token, retried } =
        await withZohoRetry(companyId, async (z) => {
          try {
            if (needVendors && vendors.length === 0) {
              vendors = await fetchVendorsFromZoho(z);
            }
            if (needAccounts && accounts.length === 0) {
              accounts = await fetchAccountsFromZoho(z);
            }
            return {
              ok: true,
              status: 200,
              raw: { vendors: vendors.length, accounts: accounts.length },
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const status = msg.includes("(401)") || msg.includes("401")
              ? 401
              : msg.includes("(403)") || msg.includes("403")
              ? 403
              : 500;
            return { ok: false, status, raw: { error: msg } };
          }
        });
      zAuth = token;
      if (
        !resultOk(tokenProbe) &&
        ((needVendors && vendors.length === 0) ||
          (needAccounts && accounts.length === 0))
      ) {
        return jsonResponse(
          {
            ok: false,
            skipped: true,
            reason: "missing_entity_cache",
            error:
              "Could not load Zoho vendors/accounts. Fix OAuth, pick an account in the review UI, or provide ZOHO_VENDORS_JSON / ZOHO_ACCOUNTS_JSON.",
            detail: tokenProbe.raw,
            retried,
            document_id: input.document_id,
          },
          400,
        );
      }
    }

    let matched = matchEntities({
      bill: mapped,
      vendors,
      accounts,
      expense_category: expenseCategory,
    });

    // Per-line account/tax choices from review outrank fuzzy matching —
    // matchEntities overwrites or strips account_id uniformly, so restore.
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

    // Explicit UI selections take precedence over fuzzy matching.
    if (input.vendor_id?.trim()) {
      const chosenVendor = input.vendor_id.trim();
      matched = {
        ...matched,
        unresolved_fields: matched.unresolved_fields.filter((f) =>
          f !== "vendor"
        ),
        bill: { ...matched.bill, vendor_id: chosenVendor },
        vendor_match: {
          vendor_id: chosenVendor,
          vendor_name: mapped.vendor_name ?? "selected",
          confidence: 1,
        },
      };
      matched.unresolved = matched.unresolved_fields.length > 0;
    }
    if (input.account_id?.trim()) {
      const chosenAccount = input.account_id.trim();
      matched = {
        ...matched,
        unresolved_fields: matched.unresolved_fields.filter((f) =>
          f !== "account"
        ),
        bill: {
          ...matched.bill,
          // The transaction-level choice fills every line that has no
          // per-line account of its own.
          line_items: matched.bill.line_items.map((item) =>
            item.account_id ? item : { ...item, account_id: chosenAccount }
          ),
        },
        account_match: {
          account_id: chosenAccount,
          account_name: "selected",
          confidence: 1,
        },
      };
      matched.unresolved = matched.unresolved_fields.length > 0;
    }

    // Vendors are NEVER created from here — masters flow from Zoho Books
    // into this app, not the other way around. An unmatched vendor routes
    // the document to review, where the reviewer picks a synced vendor
    // (creating it in Zoho Books first if it is genuinely new).

    if (matched.unresolved_fields.includes("vendor") && defaultVendorId) {
      matched = {
        ...matched,
        unresolved_fields: matched.unresolved_fields.filter((f) =>
          f !== "vendor"
        ),
        bill: { ...matched.bill, vendor_id: defaultVendorId },
        vendor_match: {
          vendor_id: defaultVendorId,
          vendor_name: mapped.vendor_name ?? "default",
          confidence: 1,
        },
      };
      matched.unresolved = matched.unresolved_fields.length > 0;
    }

    // Per-vendor default account rule. Overrides the generic category match
    // (priority: explicit UI choice > vendor rule > category match) but never
    // an account the caller chose for this transaction.
    if (!input.account_id?.trim() && matched.bill.vendor_id) {
      const rule = await lookupDefaultAccountRule(
        supabase,
        "vendor_account_rules",
        "vendor_zoho_id",
        matched.bill.vendor_id,
      );
      if (rule) {
        matched = {
          ...matched,
          unresolved_fields: matched.unresolved_fields.filter((f) =>
            f !== "account"
          ),
          bill: {
            ...matched.bill,
            // Vendor default rule fills every line without its own account.
            line_items: matched.bill.line_items.map((item) =>
              item.account_id
                ? item
                : { ...item, account_id: rule.account_zoho_id }
            ),
          },
          account_match: {
            account_id: rule.account_zoho_id,
            account_name: rule.account_name,
            confidence: 1,
          },
        };
        matched.unresolved = matched.unresolved_fields.length > 0;
      }
    }

    // Account resolution is per line now: unresolved iff any line lacks one.
    {
      const missingAccount = matched.bill.line_items.some(
        (li) => !li.account_id,
      );
      const withoutAccount = matched.unresolved_fields.filter(
        (f) => f !== "account",
      );
      matched.unresolved_fields = missingAccount
        ? [...withoutAccount, "account"]
        : withoutAccount;
      matched.unresolved = matched.unresolved_fields.length > 0;
    }

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
          hint:
            "Pick the vendor and account in the review UI. Vendors are never created from here — if this vendor is new, create it in Zoho Books, sync, then approve again.",
        },
        409,
      );
    }

    const money = await resolveCurrencyAndTax(
      supabase,
      mapped.currency,
      grossTotal,
      mapped.tax_amount,
    );

    const billBody = {
      ...toZohoBillBody(matched.bill, {
        // The document's own number is the bill number (Zoho flags true
        // duplicates per vendor); the DIC ref stays as reference_number.
        billNumber: mapped.invoice_number ||
          `DIC-${input.document_id.replace(/-/g, "").slice(0, 12)}-${Date.now().toString(36)}`,
      }),
      ...(input.tax_treatment?.trim()
        ? { tax_treatment: input.tax_treatment.trim() }
        : {}),
      ...(money.currencyId ? { currency_id: money.currencyId } : {}),
      // From the extracted row, not matched.bill — match-entities rebuilds
      // the bill object and drops passthrough header fields like due_date.
      ...(mapped.due_date ? { due_date: mapped.due_date } : {}),
    };

    // VAT belongs in the tax field, never inside the line amount.
    if (money.taxId) {
      billBody.line_items = (billBody.line_items as Array<
        Record<string, unknown>
      >).map((item, i) => {
        if (hasRealLines) {
          // Extracted lines are the printed (net) amounts: attach the
          // matched rate to lines without their own tax; keep rates as-is.
          return item.tax_id ? item : { ...item, tax_id: money.taxId };
        }
        // Implicit single line holds the gross: post net + tax_id so Zoho
        // recomputes the same gross the document shows.
        return i === 0 && money.netRate != null
          ? { ...item, rate: money.netRate, tax_id: money.taxId }
          : item;
      });
    }
    const {
      result: createResult,
      z: tokenAfterCreate,
      retried: createRetried,
    } = await withZohoRetry(companyId, (z) => createZohoBill(z, billBody));
    zAuth = tokenAfterCreate;

    let externalDocId: string;
    let recoveredExisting = false;
    if (
      createResult.ok && "externalDocId" in createResult &&
      createResult.externalDocId
    ) {
      externalDocId = createResult.externalDocId;
    } else {
      // Zoho commits bills even when our call sees a transient failure, so
      // the single retry can hit "duplicate bill number" (code 13011) for a
      // bill that actually exists. Recover it instead of failing — creates
      // stay idempotent per vendor + bill_number.
      const rawStr = JSON.stringify(createResult.raw ?? {});
      let recovered: string | null = null;
      if (rawStr.includes("13011")) {
        const { result: lookup } = await withZohoRetry(companyId, (z) =>
          findBillByNumber(
            z,
            String((billBody as { bill_number: string }).bill_number),
            String(matched.bill.vendor_id),
          )
        );
        if (lookup.ok && typeof lookup.raw === "string") {
          recovered = lookup.raw;
        }
      }
      if (!recovered) {
        throw new Error(
          `Zoho bill create failed (${createResult.status}): ${
            JSON.stringify(createResult.raw)
          }`,
        );
      }
      console.log(
        `Bill number already existed in Zoho; recovered bill ${recovered}`,
      );
      externalDocId = recovered;
      recoveredExisting = true;
    }

    const file = await loadDocumentBytes(supabase, doc.file_url as string);

    // On recovery the attachment may already be on the bill — don't duplicate.
    let skipAttach = false;
    if (recoveredExisting) {
      const { result: preGet } = await withZohoRetry(companyId, (z) =>
        getZohoBill(z, externalDocId)
      );
      if (preGet.ok && attachmentPresent(preGet.raw).present) {
        skipAttach = true;
      }
    }

    let attachResult: ZohoCallResult = {
      ok: true,
      status: 200,
      raw: { skipped: "attachment already present on recovered bill" },
    };
    let attachRetried = false;
    if (!skipAttach) {
      const {
        result,
        z: tokenAfterAttach,
        retried,
      } = await withZohoRetry(companyId, (z) =>
        attachBillDocument(
          z,
          externalDocId,
          file.bytes,
          file.contentType,
          file.filename,
        )
      );
      zAuth = tokenAfterAttach;
      attachResult = result;
      attachRetried = retried;

      if (!attachResult.ok) {
        throw new Error(
          `Zoho bill ${externalDocId} created but attachment failed (${attachResult.status}): ${
            JSON.stringify(attachResult.raw)
          }`,
        );
      }
    }

    const { result: getResult } = await withZohoRetry(companyId, (z) =>
      getZohoBill(z, externalDocId)
    );
    const attachInfo = attachmentPresent(getResult.raw);

    const { data: syncRow, error: syncError } = await supabase
      .from("erp_sync_log")
      .insert({
        document_id: input.document_id,
        source_type: "push",
        erp_name: "zoho_books",
        external_doc_id: externalDocId,
        external_kind: "bills",
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

    // Reviewer chose to apply unused vendor credit / advance to this bill.
    let billCreditsApplied: { applied: number; results: Array<Record<string, unknown>> } | null = null;
    if (input.apply_credits?.length) {
      try {
        await withZohoRetry(companyId, async (z) => {
          const r = await applyCreditsToDoc(z, "bill", externalDocId, input.apply_credits!);
          billCreditsApplied = r;
          return { ok: r.results.every((x) => x.ok), status: 200, raw: r } as ZohoCallResult;
        });
      } catch (err) {
        billCreditsApplied = { applied: 0, results: [{ ok: false, error: err instanceof Error ? err.message : String(err) }] };
      }
    }

    return jsonResponse({
      ok: true,
      post_as: "bill",
      credits_applied: billCreditsApplied,
      document_id: input.document_id,
      external_doc_id: externalDocId,
      erp_sync_log_id: syncRow.id,
      sandbox_organization_id: zAuth.organizationId,
      usage: meter.summary(),
      money_mapping: {
        currency: mapped.currency ?? null,
        currency_id: money.currencyId,
        tax_id: money.taxId,
        tax_name: money.taxName,
        net_rate: money.netRate,
        tax_amount: mapped.tax_amount ?? null,
        notes: money.notes,
      },
      retried: createRetried || attachRetried,
      attachment: {
        uploaded: attachResult.ok,
        present_on_bill: attachInfo.present,
        filename: file.filename,
        documents: attachInfo.documents,
        attach_response: attachResult.raw,
      },
      zoho_bill: getResult.ok ? getResult.raw : createResult.raw,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("zoho-push failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});

function resultOk(r: ZohoCallResult): boolean {
  return r.ok;
}
