/**
 * Talking to Zoho on a company's behalf: the metered fetch, the token, the
 * one-retry-on-auth-failure wrapper, and the create/credit calls approve
 * makes. Nothing here knows about documents or the review UI.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { zohoAuthFor, type ZohoAuth } from "../_shared/zoho_auth.ts";
import type { ApproveInput } from "./types.ts";

/**
 * The fetch every Zoho call goes through. The handler swaps in the API-usage
 * meter's fetch for the duration of a request, exactly as the module-level
 * `let` did when this lived in index.ts; the holder is here so the callers
 * that moved out with it keep behaving the same.
 */
let current: typeof fetch = fetch;
export function setZohoFetch(f: typeof fetch): void {
  current = f;
}
export function zohoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return current(input, init);
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}



export function getServiceClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Strip anything that looks like a token before it leaves this function. */
export function publicError(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  message = message.replace(
    /[0-9a-f]{20,}|1000\.[A-Za-z0-9._-]+|Zoho-oauthtoken\s+\S+/gi,
    "[redacted]",
  );
  return message.slice(0, 500);
}

/**
 * The calling company's own Zoho organisation and a token for it. This used
 * to read ZOHO_REFRESH_TOKEN and ZOHO_ORGANIZATION_ID from the environment,
 * which is one organisation for the whole deployment — see
 * _shared/zoho_auth.ts, which also holds the token cache, now per company.
 */
export async function getZoho(companyId: string): Promise<ZohoAuth> {
  return await zohoAuthFor(getServiceClient(), companyId);
}

export type ZohoCallResult = { ok: boolean; status: number; raw: unknown };

export async function withZohoRetry(
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

export function result_contact(raw: unknown): Record<string, unknown> | null {
  return ((raw as { contact?: Record<string, unknown> })?.contact) ?? null;
}

/** Organisation detail (for the seller TRN), through the metered fetch. */
export async function zohoGetJsonForOrg(companyId: string): Promise<Record<string, unknown>> {
  return await withZohoRetry(companyId, async (z) => {
    const res = await zohoFetch(`${z.apiBase}/organizations/${encodeURIComponent(z.organizationId)}?organization_id=${encodeURIComponent(z.organizationId)}`, {
      headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
    });
    const raw = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, raw };
  }).then((r) => (r.raw ?? {}) as Record<string, unknown>);
}

export async function zohoCreate(
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
export async function applyCreditsToDoc(
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
