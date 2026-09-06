/**
 * Talking to Zoho on a company's behalf: the metered fetch, the token, the
 * retry-once-on-auth-failure wrapper, and every create / attach / lookup
 * call zoho-push makes. Nothing here knows about documents or judgments.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { blobPart } from "../_shared/bytes.ts";
import { zohoAuthFor, type ZohoAuth } from "../_shared/zoho_auth.ts";
import type { ZohoAccount, ZohoVendor } from "./match-entities.ts";
import type { PushInput } from "./types.ts";

/**
 * The fetch every Zoho call goes through. The handler swaps in the API-usage
 * meter's fetch for the duration of a request, exactly as the module-level
 * `let` did when this lived in index.ts.
 */
let current: typeof fetch = fetch;
export function setZohoFetch(f: typeof fetch): void {
  current = f;
}
function zohoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return current(input, init);
}

export function getSupabase(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Find an existing bill by number + vendor (for idempotent creates). */
export async function findBillByNumber(
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
export async function getZoho(companyId: string): Promise<ZohoAuth> {
  return await zohoAuthFor(getSupabase(), companyId);
}

export type ZohoCallResult = {
  ok: boolean;
  status: number;
  raw: unknown;
};

/**
 * Run a Zoho HTTP call; on 401/403/5xx refresh token and retry once.
 */
export async function withZohoRetry<R extends ZohoCallResult>(
  companyId: string,
  call: (z: ZohoAuth) => Promise<R>,
): Promise<{ result: R; z: ZohoAuth; retried: boolean }> {
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

export async function createZohoBill(
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

export async function attachBillDocument(
  z: ZohoAuth,
  billId: string,
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): Promise<ZohoCallResult> {
  const form = new FormData();
  form.append(
    "attachment",
    new Blob([blobPart(bytes)], { type: contentType || "application/pdf" }),
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

export async function getZohoBill(
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
export async function applyCreditsToDoc(
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

export async function createZohoDoc(
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
export async function attachToZohoDoc(
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
    new Blob([blobPart(bytes)], { type: contentType || "application/pdf" }),
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

export async function fetchVendorsFromZoho(
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

export async function fetchAccountsFromZoho(
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



export function resultOk(r: ZohoCallResult): boolean {
  return r.ok;
}
