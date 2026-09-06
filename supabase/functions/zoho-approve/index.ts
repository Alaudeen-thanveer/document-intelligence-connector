// Authenticated approve → Zoho Books bill.
// Secrets come from Deno.env (local --env-file / hosted supabase secrets).
// Never returns a Zoho token. Always scopes the invoice by the caller's company.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { blobPart } from "../_shared/bytes.ts";
import { checkEInvoiceReadiness, type EInvoiceFinding } from "./einvoice.ts";
import { creditCheck, type CreditCheckResult } from "../cashflow/cash.ts";
import { detectFollowups, type Followups } from "../month-end/schedules.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
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
import { zohoAuthFor, type ZohoAuth } from "../_shared/zoho_auth.ts";
import { isAuthFail, requireUser } from "../_shared/require_user.ts";
import { companyForCaller, isCompanyFail } from "../_shared/tenant.ts";

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
  /**
   * Human override of a failed judgment. Without it, a document whose
   * latest checks include a failure is refused (409) with the failed checks
   * listed. With it, the reason is written to audit_log.
   */
  override?: boolean;
  override_reason?: string | null;
  /**
   * Human override of the line reconciliation guard. Without it, a document
   * whose extracted lines do not add up to its extracted total is refused.
   * With it, ONE line at the document total is posted (never the broken
   * lines), and the reason is audited.
   */
  override_reconciliation?: boolean;
  /** UAE VAT: emirate code for sales invoices; defaults to the customer's place_of_contact. */
  place_of_supply?: string | null;
  /**
   * Purchase order to link the bill to (Zoho purchaseorder_id). When absent
   * the PO is resolved from the bill's extracted PO number against the
   * synced open POs; "" / null disables linking.
   */
  purchaseorder_id?: string | null;
}

interface ApproveResult {
  success: boolean;
  zoho_bill_id?: string;
  error?: string;
  credits_applied?: { applied: number; ok: boolean; response?: unknown } | null;
  purchase_order?: { zoho_id: string; number: string; how: "input" | "po_number" } | null;
  /** UAE e-invoice field readiness (sales invoices only) — informs, never issues. */
  einvoice?: { findings: EInvoiceFinding[]; ready: boolean } | null;
  /** Credit control (sales invoices only): exposure vs limit. */
  credit?: CreditCheckResult | null;
  /** Bill lines that deserve a follow-up: an asset record / a prepayment schedule. */
  followups?: Followups | null;
  failed_checks?: Array<{ rule_name: string; notes: string | null }>;
  reconciliation?: Reconciliation;
  money?: { tax_id: string | null; tax_name: string | null; currency_id: string | null; notes: string[] };
  attachment?: { uploaded: boolean; filename?: string; error?: string };
  already_synced?: boolean;
}

/** Outcome of checking Σ extracted lines against the extracted total. */
interface Reconciliation {
  ok: boolean;
  /** net: lines + VAT = total · gross: lines = total (VAT inside) · implicit: no usable lines, one line at the total */
  mode: "net" | "gross" | "implicit" | "mismatch";
  lines_total: number;
  tax_amount: number;
  document_total: number;
  dropped_lines: number[];
  message: string;
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


/**
 * The calling company's own Zoho organisation and a token for it. This used
 * to read ZOHO_REFRESH_TOKEN and ZOHO_ORGANIZATION_ID from the environment,
 * which is one organisation for the whole deployment — see
 * _shared/zoho_auth.ts, which also holds the token cache, now per company.
 */
async function getZoho(companyId: string): Promise<ZohoAuth> {
  return await zohoAuthFor(getServiceClient(), companyId);
}

type ZohoCallResult = { ok: boolean; status: number; raw: unknown };

async function withZohoRetry(
  companyId: string,
  call: (z: ZohoAuth) => Promise<ZohoCallResult>,
): Promise<ZohoCallResult> {
  let z = await getZoho(companyId);
  let result = await call(z);
  if (
    !result.ok &&
    (result.status === 401 || result.status === 403 || result.status >= 500)
  ) {
    // A cached token can be revoked before it expires; ask for a new one.
    z = await zohoAuthFor(getServiceClient(), companyId, { forceRefresh: true });
    result = await call(z);
  }
  return result;
}

function result_contact(raw: unknown): Record<string, unknown> | null {
  return ((raw as { contact?: Record<string, unknown> })?.contact) ?? null;
}

/** Organisation detail (for the seller TRN), through the metered fetch. */
async function zohoGetJsonForOrg(companyId: string): Promise<Record<string, unknown>> {
  return await withZohoRetry(companyId, async (z) => {
    const res = await zohoFetch(`${z.apiBase}/organizations/${encodeURIComponent(z.organizationId)}?organization_id=${encodeURIComponent(z.organizationId)}`, {
      headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
    });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, raw };
  }).then((r) => (r.raw ?? {}) as Record<string, unknown>);
}

async function zohoCreate(
  companyId: string,
  path: "bills" | "invoices" | "expenses",
  body: Record<string, unknown>,
): Promise<{ id: string | null; result: ZohoCallResult }> {
  const result = await withZohoRetry(companyId, async (z) => {
    const res = await zohoFetch(
      `${z.apiBase}/${path}?organization_id=${encodeURIComponent(z.organizationId)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${z.accessToken}`,
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
  companyId: string,
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
  const result = await withZohoRetry(companyId, async (z) => {
    const res = await zohoFetch(
      `${z.apiBase}/${docKind === "invoice" ? "invoices" : "bills"}/${encodeURIComponent(docId)}/credits?organization_id=${encodeURIComponent(z.organizationId)}`,
      { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok && (raw as { code?: number })?.code === 0, status: res.status, raw };
  });
  return { applied: result.ok ? wanted.reduce((t, c) => t + Number(c.amount), 0) : 0, ok: result.ok, response: result.raw };
}

// ---------------------------------------------------------------------------
// Money: VAT → tax_id, currency → currency_id (ported from zoho-push).
// VAT lives in Zoho's tax field, never inside a line amount: when the
// document's VAT matches a synced tax rate, lines are posted NET + tax_id so
// Zoho recomputes the same gross the invoice shows.
// ---------------------------------------------------------------------------
async function resolveMoney(
  supabase: SupabaseClient,
  currencyCode: string | null | undefined,
  grossTotal: number,
  taxAmount: number | null | undefined,
): Promise<{ taxId: string | null; taxName: string | null; taxPct: number | null; currencyId: string | null; notes: string[] }> {
  const notes: string[] = [];
  let currencyId: string | null = null, taxId: string | null = null, taxName: string | null = null, taxPct: number | null = null;
  if (currencyCode) {
    const { data } = await supabase.from("zoho_entities").select("zoho_id").eq("kind", "currency").eq("name", currencyCode).maybeSingle();
    if (data?.zoho_id) currencyId = String(data.zoho_id);
    else notes.push(`currency ${currencyCode} not in synced Zoho currencies — Zoho default applies`);
  }
  if (taxAmount != null && taxAmount > 0 && grossTotal > taxAmount) {
    const net = grossTotal - taxAmount;
    const pct = (taxAmount / net) * 100;
    const { data: taxes } = await supabase.from("zoho_entities").select("zoho_id, name, extra").eq("kind", "tax");
    const match = (taxes ?? []).find((t) => {
      const p = Number((t.extra as { percentage?: unknown })?.percentage);
      return Number.isFinite(p) && p > 0 && Math.abs(p - pct) <= 0.5;
    });
    if (match) { taxId = String(match.zoho_id); taxName = String(match.name); taxPct = Number((match.extra as { percentage?: unknown }).percentage); }
    else notes.push(`VAT ${taxAmount} on ${grossTotal} (~${pct.toFixed(1)}%) matches no synced Zoho tax rate — posted without tax_id`);
  }
  return { taxId, taxName, taxPct, currencyId, notes };
}

/**
 * Do the extracted lines add up to the extracted total? Tolerance is 0.05
 * plus 0.1% of the total (OCR rounding). Lines with no usable rate are
 * reported as dropped — they never disappear silently.
 */
function reconcile(
  mapped: { line_items: Array<{ rate: number; quantity: number }> },
  lineRows: ExtractedLineItemRow[],
  documentTotal: number,
  taxAmount: number | null,
): Reconciliation {
  const tax = taxAmount != null && taxAmount > 0 ? taxAmount : 0;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const hasRealLines = lineRows.length > 0;
  const dropped = lineRows
    .filter((li) => { const rate = li.rate == null || li.rate === "" ? null : Number(li.rate); const amt = li.amount == null || li.amount === "" ? null : Number(li.amount); return (rate == null || !Number.isFinite(rate)) && (amt == null || !Number.isFinite(amt)); })
    .map((li) => Number(li.line_no));
  if (!hasRealLines || dropped.length === lineRows.length) {
    // No lines, or none readable at all: the header total is the only
    // reliable money. One line at the total (the old behaviour), flagged.
    return { ok: true, mode: "implicit", lines_total: round2(documentTotal), tax_amount: tax, document_total: round2(documentTotal), dropped_lines: dropped,
      message: hasRealLines ? `no extracted line had a readable amount — one line at the document total` : "no extracted lines — one line at the document total" };
  }
  const linesTotal = round2(mapped.line_items.reduce((t, li) => t + li.rate * li.quantity, 0));
  const tol = 0.05 + documentTotal * 0.001;
  const asNet = Math.abs(linesTotal + tax - documentTotal);
  const asGross = Math.abs(linesTotal - documentTotal);
  if (dropped.length === 0 && asNet <= tol) return { ok: true, mode: "net", lines_total: linesTotal, tax_amount: tax, document_total: round2(documentTotal), dropped_lines: [], message: `lines ${linesTotal.toFixed(2)} + VAT ${tax.toFixed(2)} = total ${documentTotal.toFixed(2)}` };
  if (dropped.length === 0 && tax > 0 && asGross <= tol) return { ok: true, mode: "gross", lines_total: linesTotal, tax_amount: tax, document_total: round2(documentTotal), dropped_lines: [], message: `lines ${linesTotal.toFixed(2)} already include VAT ${tax.toFixed(2)} (= total)` };
  if (dropped.length === 0 && tax === 0 && asGross <= tol) return { ok: true, mode: "net", lines_total: linesTotal, tax_amount: 0, document_total: round2(documentTotal), dropped_lines: [], message: `lines ${linesTotal.toFixed(2)} = total ${documentTotal.toFixed(2)}` };
  const why = dropped.length
    ? `line${dropped.length > 1 ? "s" : ""} ${dropped.join(", ")} ha${dropped.length > 1 ? "ve" : "s"} no amount (OCR could not read quantity × rate) — fix the line${dropped.length > 1 ? "s" : ""} in review`
    : `lines ${linesTotal.toFixed(2)}${tax ? ` + VAT ${tax.toFixed(2)} = ${(linesTotal + tax).toFixed(2)}` : ""} do not match the document total ${documentTotal.toFixed(2)} — correct the lines or the total in review`;
  return { ok: false, mode: "mismatch", lines_total: linesTotal, tax_amount: tax, document_total: round2(documentTotal), dropped_lines: dropped, message: why };
}

/** UAE emirate → Zoho place_of_supply code. */
const EMIRATE_CODES: Record<string, string> = {
  "abu dhabi": "AB", ajman: "AJ", dubai: "DU", fujairah: "FU", "ras al khaimah": "RA", "ras al-khaimah": "RA", sharjah: "SH", "umm al quwain": "UQ", "umm al-quwain": "UQ",
};
function emirateCode(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^[A-Z]{2}$/.test(s)) return s;
  return EMIRATE_CODES[s.toLowerCase()] ?? null;
}

/**
 * Emirate code for place_of_supply (UAE VAT requires it on sales invoices).
 * Contacts in the UAE edition carry no place-of-contact field, so: explicit
 * input → the customer's billing state code → company default → the Zoho
 * organisation's own emirate.
 */
async function resolvePlaceOfSupply(
  supabase: SupabaseClient,
  explicit: string | null | undefined,
  customerId: string,
  companyId: string,
): Promise<string | null> {
  if (explicit?.trim()) return emirateCode(explicit) ?? explicit.trim();
  const contact = await withZohoRetry(companyId, async (z) => {
    const res = await zohoFetch(`${z.apiBase}/contacts/${encodeURIComponent(customerId)}?organization_id=${encodeURIComponent(z.organizationId)}`, { headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` } });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, raw };
  });
  const c = (contact.raw as { contact?: { place_of_contact?: string; billing_address?: { state_code?: string; state?: string } } })?.contact;
  const fromContact = emirateCode(c?.place_of_contact) ?? emirateCode(c?.billing_address?.state_code) ?? emirateCode(c?.billing_address?.state);
  if (fromContact) return fromContact;
  const { data: cfg } = await supabase.from("company_config").select("default_place_of_supply").eq("company_id", companyId).maybeSingle();
  const fromCompany = emirateCode(cfg?.default_place_of_supply);
  if (fromCompany) return fromCompany;
  // Needed after the call returns as well, to pick this company's org out of
  // the list, so resolve it here rather than reaching into the callback.
  const zOrg = (await getZoho(companyId)).organizationId;
  const org = await withZohoRetry(companyId, async (z) => {
    const res = await zohoFetch(`${z.apiBase}/organizations?organization_id=${encodeURIComponent(z.organizationId)}`, { headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` } });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, raw };
  });
  const o = ((org.raw as { organizations?: Array<Record<string, unknown>> })?.organizations ?? []).find((x) => String(x.organization_id) === zOrg) ?? ((org.raw as { organizations?: Array<Record<string, unknown>> })?.organizations ?? [])[0];
  return emirateCode(o?.state) ?? emirateCode((o?.address as { state?: string } | undefined)?.state) ?? null;
}

/** The document's bytes: private storage ref (storage://invoices/path), legacy public URL, or a fetchable URL. */
async function loadDocumentBytes(
  supabase: SupabaseClient,
  fileUrl: string,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  let path: string | null = null;
  if (fileUrl.startsWith("storage://invoices/")) path = fileUrl.slice("storage://invoices/".length);
  const publicMarker = "/storage/v1/object/public/invoices/";
  const idx = fileUrl.indexOf(publicMarker);
  if (!path && idx >= 0) path = decodeURIComponent(fileUrl.slice(idx + publicMarker.length));
  if (path) {
    const { data, error } = await supabase.storage.from("invoices").download(path);
    if (error || !data) throw new Error(`storage download failed: ${error?.message ?? "no data"}`);
    return { bytes: new Uint8Array(await data.arrayBuffer()), contentType: data.type || "application/pdf", filename: path.split("/").pop() || "document.pdf" };
  }
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`fetch document failed (${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/pdf", filename: fileUrl.split("/").pop()?.split("?")[0] || "document.pdf" };
}

/** Attach the source document to the Zoho record. Best effort; never undoes the document. */
async function attachDocument(
  companyId: string,
  supabase: SupabaseClient,
  fileUrl: string | null,
  zohoPath: string,
  fieldName: "attachment" | "receipt",
): Promise<{ uploaded: boolean; filename?: string; error?: string }> {
  if (!fileUrl) return { uploaded: false, error: "no file on document" };
  try {
    const file = await loadDocumentBytes(supabase, fileUrl);
    const result = await withZohoRetry(companyId, async (z) => {
      const form = new FormData();
      form.append(fieldName, new Blob([blobPart(file.bytes)], { type: file.contentType }), file.filename);
      const res = await zohoFetch(`${z.apiBase}/${zohoPath}?organization_id=${encodeURIComponent(z.organizationId)}`, { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` }, body: form });
      const raw = await res.json().catch(async () => await res.text());
      return { ok: res.ok && ((raw as { code?: number })?.code ?? 0) === 0, status: res.status, raw };
    });
    return result.ok ? { uploaded: true, filename: file.filename } : { uploaded: false, filename: file.filename, error: publicError(JSON.stringify(result.raw).slice(0, 200)) };
  } catch (err) {
    return { uploaded: false, error: publicError(err) };
  }
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

  // A signed-in person only. Scripts that post to Zoho use zoho-push, which
  // accepts the service role; nothing calls approve as the system.
  const auth = await requireUser(req, {
    corsHeaders: CORS_HEADERS,
    errorBody: (m) => ({ success: false, error: m }),
  });
  if (isAuthFail(auth)) return auth.response;
  if (!auth.user) {
    return jsonResponse({ success: false, error: "Sign in required" }, 401);
  }
  const user = auth.user;

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

  // Whose invoice is this? Its company is the target, and the caller must be
  // a member of that company — the rule every other function applies. This
  // used to read a company_id stamped on the login account, which gives a
  // person one company for life: staff who serve several clients have one
  // login, not one per client, and nothing in the request could say which
  // client an approval was for. A wrong company answers 404, never 403, so
  // the refusal does not confirm the invoice exists.
  const tenant = await companyForCaller(auth, {
    documentId: invoiceId,
    cors: CORS_HEADERS,
    errorBody: (m) => ({ success: false, error: m }),
  });
  if (isCompanyFail(tenant)) return tenant.response;
  const companyId = tenant.companyId;

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
      detail: { error, ...extra, ...(input.override ? { override_reason: input.override_reason ?? null } : {}) },
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

    // Idempotent: a document already in Zoho Books is never posted twice.
    const { data: docFull } = await supabase.from("documents").select("zoho_bill_id").eq("id", invoiceId).maybeSingle();
    if (doc.status === "synced" && docFull?.zoho_bill_id) {
      return jsonResponse({ success: true, zoho_bill_id: String(docFull.zoho_bill_id), already_synced: true });
    }

    // Judgment gate: a failed check needs an explicit, audited human override.
    const { data: jr } = await supabase.from("judgment_results").select("rule_name, passed, notes").eq("document_id", invoiceId);
    const failedChecks = (jr ?? []).filter((r) => r.passed === false).map((r) => ({ rule_name: String(r.rule_name), notes: (r.notes as string | null) ?? null }));
    if (failedChecks.length && !input.override) {
      return jsonResponse({
        success: false,
        error: `Judgment has ${failedChecks.length} failed check${failedChecks.length > 1 ? "s" : ""} (${failedChecks.map((f) => f.rule_name).join(", ")}). Approve with an override reason to post anyway.`,
        failed_checks: failedChecks,
      }, 409);
    }
    if (failedChecks.length && input.override && !input.override_reason?.trim()) {
      return jsonResponse({ success: false, error: "An override reason is required when posting over a failed check.", failed_checks: failedChecks }, 400);
    }

    const { data: extracted, error: extractedError } = await supabase
      .from("extracted_fields")
      .select(
        "id, document_id, vendor_raw, total_amount, invoice_date, currency, tax_amount, invoice_number, due_date, po_number",
      )
      .eq("document_id", invoiceId)
      // the current extraction: newest first, id only as the tiebreak
      .order("created_at", { ascending: false })
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

    let mapped = mapExtractedFieldsToZohoBill(
      extracted as ExtractedFieldsRow,
      lineRows,
    );
    const postAs: PostAs = input.post_as ?? "bill";
    let purchaseOrder: ApproveResult["purchase_order"] = null;
    let einvoice: ApproveResult["einvoice"] = null;
    let creditResult: CreditCheckResult | null = null;
    /** Snapshot of the created bill's lines, for follow-up detection. */
    let billLineSnapshot: Array<{ description: string | null; amount: number; account_id: string | null }> = [];

    // Period lock (item 10): nothing posts into a locked period through this
    // app. Hard refusal — no override; unlock the period (audited) to change
    // history. The document can still be posted DATED AFTER the lock.
    {
      const { data: lockRow } = await supabase.from("company_config").select("locked_until").eq("company_id", companyId).maybeSingle();
      const lockedUntil = lockRow?.locked_until ? String(lockRow.locked_until) : null;
      const docDate = (extracted.invoice_date as string | null) ?? null;
      if (lockedUntil && docDate && docDate <= lockedUntil) {
        return await fail(
          `The books are locked through ${lockedUntil} — this document is dated ${docDate} and cannot be posted into a filed period. Unlock the period first, or post it dated after the lock.`,
          { locked_until: lockedUntil, document_date: docDate },
        );
      }
    }

    // Money: resolve VAT → tax_id and currency; reconcile lines vs total.
    const documentTotal = Number(extracted.total_amount ?? 0) || 0;
    const taxAmount = extracted.tax_amount != null && extracted.tax_amount !== "" ? Number(extracted.tax_amount) : null;
    const money = await resolveMoney(supabase, extracted.currency as string | null, documentTotal, taxAmount);
    let recon = reconcile(mapped, lineRows, documentTotal, taxAmount);
    if (!recon.ok) {
      if (!input.override_reconciliation) {
        return jsonResponse({
          success: false,
          error: `Lines do not reconcile: ${recon.message}.`,
          reconciliation: recon,
        }, 422);
      }
      // Override: post the document total as ONE line, never the broken lines.
      mapped = { ...mapped, line_items: [{ description: mapped.line_items[0]?.description ?? `Document ${mapped.invoice_number ?? invoiceId.slice(0, 8)}`, rate: documentTotal, quantity: 1 }] };
      recon = { ...recon, ok: true, mode: "implicit", message: `override: posted as one line at the document total (${recon.message})` };
    }
    // Apply VAT: lines are net → add tax_id; lines/implicit are gross → make them net first.
    if (money.taxId && money.taxPct != null) {
      const netOf = (gross: number) => Math.round((gross / (1 + money.taxPct! / 100)) * 100) / 100;
      mapped = {
        ...mapped,
        line_items: mapped.line_items.map((li) => {
          const rate = recon.mode === "net" ? li.rate : netOf(li.rate);
          return { ...li, rate, ...(li.tax_id ? {} : { tax_id: money.taxId! }) };
        }),
      };
    }

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
      const pos = await resolvePlaceOfSupply(supabase, input.place_of_supply, customerId, companyId);
      if (!pos) {
        return await fail("Zoho needs a place of supply for this customer (UAE VAT). Set the emirate on the customer in Zoho Books and sync, or pass place_of_supply.");
      }
      // Credit control (item 15): the customer's exposure (open balance +
      // this invoice) against their limit — Zoho's own credit_limit when the
      // org enables it, else the app-side map. Over the limit refuses; a
      // human override (with a reason, audited) still posts.
      {
        const { data: cfgRow } = await supabase.from("company_config").select("credit_limits").eq("company_id", companyId).maybeSingle();
        const limits = (cfgRow?.credit_limits ?? {}) as Record<string, number>;
        let fresh: Record<string, unknown> = {};
        try {
          const res = await withZohoRetry(companyId, async (z) => {
            const r = await zohoFetch(`${z.apiBase}/contacts/${encodeURIComponent(customerId)}?organization_id=${encodeURIComponent(z.organizationId)}`, { headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` } });
            return { ok: r.ok, status: r.status, raw: await r.json().catch(() => ({})) };
          });
          fresh = ((result_contact(res.raw))) ?? {};
        } catch { /* fall back to the cached extra */ }
        const { data: custCache } = await supabase.from("zoho_entities").select("name, extra").eq("kind", "customer").eq("zoho_id", customerId).maybeSingle();
        const cachedExtra = (custCache?.extra as Record<string, unknown>) ?? {};
        creditResult = creditCheck({
          customer_name: (fresh.contact_name as string | undefined) ?? (custCache?.name as string | undefined) ?? "the customer",
          zoho_credit_limit: fresh.credit_limit != null && Number(fresh.credit_limit) > 0 ? Number(fresh.credit_limit) : (cachedExtra.credit_limit != null ? Number(cachedExtra.credit_limit) : null),
          app_credit_limit: limits[customerId] != null ? Number(limits[customerId]) : null,
          outstanding: fresh.outstanding_receivable_amount != null ? Number(fresh.outstanding_receivable_amount) : Number(cachedExtra.outstanding_receivable ?? 0) || 0,
          unused_credits: fresh.unused_credits_receivable_amount != null ? Number(fresh.unused_credits_receivable_amount) : Number(cachedExtra.unused_credits_receivable ?? 0) || 0,
          invoice_total: documentTotal,
        });
        if (creditResult.over && !input.override) {
          return jsonResponse({
            success: false,
            error: `Credit limit: ${creditResult.note}`,
            failed_checks: [{ rule_name: "credit_limit_exceeded", notes: creditResult.note }],
            credit: creditResult,
          }, 409);
        }
      }

      // UAE e-invoice field readiness (item 9): verify what the PINT AE
      // e-invoice will need BEFORE the invoice exists in Zoho. Informs the
      // reviewer; issuance stays with Zoho and the accredited provider —
      // this tool never issues a sales invoice.
      {
        const { data: custRow } = await supabase.from("zoho_entities").select("name, extra").eq("kind", "customer").eq("zoho_id", customerId).maybeSingle();
        const custExtra = (custRow?.extra as Record<string, unknown>) ?? {};
        let sellerTrn: string | null = null;
        try {
          const orgRaw = await zohoGetJsonForOrg(companyId);
          sellerTrn = (((orgRaw.organization as Record<string, unknown> | undefined)?.tax_settings ?? {}) as Record<string, unknown>).tax_reg_no as string | undefined || null;
        } catch { /* reported as missing */ }
        einvoice = checkEInvoiceReadiness({
          seller_trn: sellerTrn,
          buyer: { name: (custRow?.name as string | undefined) ?? null, trn: (custExtra.tax_reg_no as string | undefined) || null, tax_treatment: (custExtra.tax_treatment as string | undefined) || null },
          place_of_supply: pos,
          date: mapped.date ?? null,
          currency: (extracted.currency as string | null) ?? "AED",
          lines: mapped.line_items.map((li) => ({ description: li.description ?? null, tax_id: li.tax_id ?? null })),
        });
      }

      const created = await zohoCreate(companyId, "invoices", {
        customer_id: customerId,
        date: mapped.date,
        place_of_supply: pos,
        ...(money.currencyId ? { currency_id: money.currencyId } : {}),
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
        return await fail(`Zoho invoice create failed: ${publicError(String((created.result.raw as { message?: string })?.message ?? created.result.status))}`, {
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
      // Expense amount: the document total, net of VAT when a tax matched
      // (tax_id then makes Zoho re-add it), else the gross.
      const expenseNet = money.taxId && money.taxPct != null ? Math.round((documentTotal / (1 + money.taxPct / 100)) * 100) / 100 : documentTotal;
      const created = await zohoCreate(companyId, "expenses", {
        account_id: accountId,
        paid_through_account_id: paidThrough,
        date: mapped.date,
        amount: expenseNet,
        ...(money.taxId ? { tax_id: money.taxId } : {}),
        ...(money.currencyId ? { currency_id: money.currencyId } : {}),
        ...(mapped.invoice_number ? { reference_number: mapped.invoice_number } : {}),
        ...(input.vendor_id?.trim() ? { vendor_id: input.vendor_id.trim() } : {}),
        ...(input.tax_treatment?.trim()
          ? { tax_treatment: input.tax_treatment.trim() }
          : {}),
      });
      // Zoho answers an expense create with code 0 / "The expense has been
      // recorded." and NO expense object — find the id by reference.
      if (created.result.ok && !created.id && ((created.result.raw as { code?: number })?.code ?? 0) === 0) {
        const ref = mapped.invoice_number?.trim();
        const lookup = await withZohoRetry(companyId, async (z) => {
          const qs = new URLSearchParams({ organization_id: z.organizationId, ...(ref ? { reference_number: ref } : {}), sort_column: "created_time", sort_order: "D", per_page: "5" });
          const res = await zohoFetch(`${z.apiBase}/expenses?${qs}`, { headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` } });
          const raw = await res.json().catch(() => ({}));
          return { ok: res.ok, status: res.status, raw };
        });
        const hit = ((lookup.raw as { expenses?: Array<Record<string, unknown>> })?.expenses ?? [])[0];
        if (hit?.expense_id) created.id = String(hit.expense_id);
      }
      if (!created.result.ok || !created.id) {
        return await fail(`Zoho expense create failed: ${publicError(String((created.result.raw as { message?: string })?.message ?? created.result.status))}`, {
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
      // Purchase order link (item 7): explicit from review, else by the PO
      // number read off the bill against the synced open POs.
      if (input.purchaseorder_id === undefined) {
        const wantPo = String((extracted as { po_number?: string | null }).po_number ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (wantPo.length >= 3) {
          const { data: poRows } = await supabase.from("zoho_entities").select("zoho_id, name, extra").eq("kind", "purchase_order");
          const normPo = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          const hit = (poRows ?? []).find((r) => normPo(r.name) === wantPo || normPo((r.extra as Record<string, unknown>)?.reference_number) === wantPo);
          if (hit) purchaseOrder = { zoho_id: String(hit.zoho_id), number: String(hit.name), how: "po_number" };
        }
      } else if (input.purchaseorder_id) {
        const { data: poRow } = await supabase.from("zoho_entities").select("zoho_id, name").eq("kind", "purchase_order").eq("zoho_id", input.purchaseorder_id).maybeSingle();
        purchaseOrder = { zoho_id: input.purchaseorder_id, number: poRow ? String(poRow.name) : input.purchaseorder_id, how: "input" };
      }
      const created = await zohoCreate(companyId, "bills", {
        vendor_id: matched.bill.vendor_id,
        bill_number: billNumber,
        ...(purchaseOrder ? { purchaseorder_ids: [purchaseOrder.zoho_id] } : {}),
        date: mapped.date,
        ...(money.currencyId ? { currency_id: money.currencyId } : {}),
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
        return await fail(`Zoho bill create failed: ${publicError(String((created.result.raw as { message?: string })?.message ?? created.result.status))}`, {
          status: created.result.status,
        });
      }
      zohoId = created.id;
      billLineSnapshot = matched.bill.line_items.map((li) => ({ description: li.description ?? null, amount: Math.round(Number(li.rate) * Number(li.quantity) * 100) / 100, account_id: li.account_id ?? null }));
    }

    // Follow-ups from the bill's lines (item 16): a line on a fixed-asset
    // account proposes an asset record; a line on a "Prepaid …" account
    // proposes a prepayment schedule. Proposals only — a human confirms
    // each on the Month-end page; nothing is created in Zoho here.
    let followups: Followups | null = null;
    if (postAs === "bill" && zohoId) {
      try {
        const accountIds = [...new Set(billLineSnapshot.map((li) => li.account_id).filter(Boolean))] as string[];
        const { data: accRows } = accountIds.length
          ? await supabase.from("zoho_entities").select("zoho_id, name, extra").eq("kind", "account").in("zoho_id", accountIds)
          : { data: [] as Array<Record<string, unknown>> };
        const accMap = new Map((accRows ?? []).map((a) => [String(a.zoho_id), { name: String(a.name), account_type: String(((a.extra as Record<string, unknown>) ?? {}).account_type ?? "") }]));
        followups = detectFollowups(billLineSnapshot, accMap);
        const billNo = mapped.invoice_number?.trim() || zohoId;
        for (const a of followups.assets) {
          await supabase.from("bk_asset_proposals").upsert({
            company_id: companyId, document_id: invoiceId, bill_zoho_id: zohoId, bill_number: billNo,
            line_description: a.description, amount: a.amount, asset_account_id: a.account_id, asset_account_name: a.account_name,
            purchase_date: mapped.date ?? null, status: "proposed",
          }, { onConflict: "company_id,bill_zoho_id,line_description", ignoreDuplicates: true });
        }
        for (const pnew of followups.prepayments) {
          const startPeriod = String(mapped.date ?? new Date().toISOString().slice(0, 10)).slice(0, 7);
          const { data: existing } = await supabase.from("bk_schedules").select("id").eq("company_id", companyId).eq("source_zoho_id", zohoId).eq("label", pnew.description).maybeSingle();
          if (existing) continue;
          await supabase.from("bk_schedules").insert({
            company_id: companyId, kind: "prepayment", label: pnew.description, source_kind: "bill", source_zoho_id: zohoId, source_number: billNo,
            bs_account_id: pnew.account_id, bs_account_name: pnew.account_name,
            // The P&L side is the reviewer's choice — left empty on purpose;
            // the schedule stays "proposed" until they pick it and activate.
            pl_account_id: "", pl_account_name: null,
            total: pnew.amount, months: 12, start_period: startPeriod, status: "proposed", created_by: user.email ?? "reviewer",
          });
        }
      } catch (err) {
        console.warn("followup detection failed:", err instanceof Error ? err.message : String(err));
      }
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

    // Attach the source document (best effort; the Zoho record already exists).
    const attachment = zohoId
      ? await attachDocument(
          companyId,
        supabase,
        (doc.file_url as string | null) ?? null,
        postAs === "invoice" ? `invoices/${zohoId}/attachment` : postAs === "expense" ? `expenses/${zohoId}/receipt` : `bills/${zohoId}/attachment`,
        postAs === "expense" ? "receipt" : "attachment",
      )
      : { uploaded: false, error: "no zoho id" };

    // Reviewer chose to apply unused credit (advance / credit note / vendor
    // credit) to this invoice or bill. Best-effort, after the document
    // exists; reported, never fatal.
    let creditsApplied: ApproveResult["credits_applied"] = null;
    if (zohoId && postAs !== "expense" && input.apply_credits?.length) {
      try {
        creditsApplied = await applyCreditsToDoc(companyId, postAs === "invoice" ? "invoice" : "bill", zohoId, input.apply_credits);
      } catch (err) {
        creditsApplied = { applied: 0, ok: false, response: publicError(err) };
      }
    }
    await writeAudit(supabase, {
      company_id: companyId,
      invoice_id: invoiceId,
      actor_id: user.id,
      action: "zoho_synced",
      detail: {
        zoho_bill_id: zohoId, post_as: postAs, credits_applied: creditsApplied?.applied ?? 0, purchase_order: purchaseOrder?.number ?? null,
        reconciliation: recon.mode, tax: money.taxName, attachment: attachment.uploaded,
        ...(failedChecks.length ? { override_reason: input.override_reason, overridden_checks: failedChecks.map((f) => f.rule_name) } : {}),
        ...(recon.message.startsWith("override") ? { reconciliation_override: recon.message } : {}),
      },
    });

    return jsonResponse({
      success: true, zoho_bill_id: zohoId ?? undefined, credits_applied: creditsApplied, purchase_order: purchaseOrder, einvoice, credit: creditResult, followups,
      reconciliation: recon, money: { tax_id: money.taxId, tax_name: money.taxName, currency_id: money.currencyId, notes: money.notes }, attachment,
    });
  } catch (err) {
    return await fail(publicError(err));
  }
});
