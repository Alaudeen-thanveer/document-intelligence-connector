/**
 * Reading a company's Zoho Books history: the token, a GET with gentle
 * backoff, listing document ids per kind, and turning a Zoho payload into
 * the HistoryDoc the analysis layers consume. Bank transactions have their
 * own module; this one is the party->account documents.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { zohoAuthFor, type ZohoAuth } from "../_shared/zoho_auth.ts";
import type { HistoryDoc } from "./analyze.ts";
import { parseZohoLineTags } from "./tags_projects.ts";

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

export type DocKind =
  | "bill"
  | "invoice"
  | "expense"
  | "journal"
  | "vendorpayment"
  | "customerpayment";
export const KIND_META: Record<
  DocKind,
  { path: string; listKey: string; idKey: string; rootKey: string }
> = {
  bill: { path: "bills", listKey: "bills", idKey: "bill_id", rootKey: "bill" },
  invoice: {
    path: "invoices",
    listKey: "invoices",
    idKey: "invoice_id",
    rootKey: "invoice",
  },
  expense: {
    path: "expenses",
    listKey: "expenses",
    idKey: "expense_id",
    rootKey: "expense",
  },
  journal: {
    path: "journals",
    listKey: "journals",
    idKey: "journal_id",
    rootKey: "journal",
  },
  vendorpayment: {
    path: "vendorpayments",
    listKey: "vendorpayments",
    idKey: "payment_id",
    rootKey: "vendorpayment",
  },
  customerpayment: {
    path: "customerpayments",
    listKey: "customerpayments",
    idKey: "payment_id",
    rootKey: "payment",
  },
};

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


// ---------------------------------------------------------------------------
// OAuth: cached z first (Zoho throttles refresh hard), refresh on miss.
// ---------------------------------------------------------------------------

/**
 * The company's own Zoho organisation and a z for it. This used to read
 * ZOHO_REFRESH_TOKEN and ZOHO_ORGANIZATION_ID from the environment, which is
 * one organisation for the whole deployment — see _shared/zoho_auth.ts.
 */
export async function getAccessToken(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ZohoAuth> {
  return await zohoAuthFor(supabase, companyId);
}

// ---------------------------------------------------------------------------
// Zoho fetch with gentle backoff on 429 / 5xx.
// ---------------------------------------------------------------------------
export async function zohoGet(
  z: ZohoAuth,
  path: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ organization_id: z.organizationId, ...params });
  const url = `${z.apiBase}/${path}?${qs.toString()}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await zohoFetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
    });
    const raw = await res.json().catch(() => ({}));
    if (res.ok) return raw as Record<string, unknown>;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      continue;
    }
    throw new Error(
      `Zoho ${path} failed (${res.status}): ${JSON.stringify(raw)}`,
    );
  }
  throw new Error(`Zoho ${path}: retries exhausted`);
}

export async function listIds(
  z: ZohoAuth,
  kind: DocKind,
  fromDate: string,
  cap: number,
): Promise<string[]> {
  const { path, listKey, idKey } = KIND_META[kind];
  const ids: string[] = [];
  let page = 1;
  while (ids.length < cap && page <= 50) {
    // Journals use journal_date for filtering/sorting; the others use date.
    const dateField = kind === "journal" ? "journal_date" : "date";
    const raw = await zohoGet(z, path, {
      per_page: "200",
      page: String(page),
      [`${dateField}_start`]: fromDate,
      sort_column: dateField,
      sort_order: "D",
    });
    const items = (raw[listKey] as Array<Record<string, unknown>>) ?? [];
    for (const it of items) {
      if (it[idKey] != null) ids.push(String(it[idKey]));
      if (ids.length >= cap) break;
    }
    const more = Boolean(
      (raw as { page_context?: { has_more_page?: boolean } }).page_context
        ?.has_more_page,
    );
    if (!more) break;
    page++;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Zoho payload → HistoryDoc.
// ---------------------------------------------------------------------------
export function toHistoryDoc(
  kind: DocKind,
  raw: Record<string, unknown>,
): HistoryDoc | null {
  // Payments feed layer 6 and bank transactions feed bank layer 1; neither
  // is a party→account document.
  if (!KIND_META[kind]) return null;
  if (kind === "vendorpayment" || kind === "customerpayment") return null;
  const doc = (raw[KIND_META[kind].rootKey] ?? raw) as Record<string, unknown>;

  // Journals have no party; expenses and bills have a vendor; invoices a customer.
  const partyId = kind === "journal"
    ? ""
    : kind === "invoice"
    ? doc.customer_id
    : doc.vendor_id;
  const partyName = kind === "journal"
    ? ""
    : kind === "invoice"
    ? doc.customer_name
    : doc.vendor_name;
  if (kind !== "journal" && partyId == null) return null;

  const rawLines = (doc.line_items as Array<Record<string, unknown>>) ?? [];
  // Expenses are flat (one account, one amount) with header-level tags/project.
  const lineSource = kind === "expense" && rawLines.length === 0
    ? [{
      account_id: doc.account_id,
      account_name: doc.account_name,
      amount: doc.total ?? doc.amount,
      tags: doc.tags,
      project_id: doc.project_id,
      project_name: doc.project_name,
    }]
    : rawLines;

  const lines = lineSource.map((li) => ({
    account_id: li.account_id != null ? String(li.account_id) : null,
    account_name: li.account_name != null ? String(li.account_name) : null,
    // Journals: signed by debit/credit so both sides are visible.
    amount: kind === "journal"
      ? ((Number(li.debit_amount ?? 0) ||
          (String(li.debit_or_credit ?? "").toLowerCase() === "debit"
            ? Number(li.amount ?? 0) || 0
            : 0)) -
        (Number(li.credit_amount ?? 0) ||
          (String(li.debit_or_credit ?? "").toLowerCase() === "credit"
            ? Number(li.amount ?? 0) || 0
            : 0)))
      : Number(li.item_total ?? li.amount ?? 0) || 0,
    tags: parseZohoLineTags(li.tags),
    project_id: li.project_id != null && String(li.project_id) !== ""
      ? String(li.project_id)
      : null,
    project_name: li.project_name != null ? String(li.project_name) : null,
  }));

  const hasPo = Boolean(
    (kind === "bill" &&
      (doc.purchaseorder_ids as unknown[] | undefined)?.length) ||
      String(doc.reference_number ?? "").trim(),
  );

  return {
    doc_kind: kind,
    zoho_id: String(doc[KIND_META[kind].idKey] ?? ""),
    party_zoho_id: String(partyId ?? ""),
    party_name: String(partyName ?? ""),
    date: String(doc.date ?? doc.journal_date ?? "").slice(0, 10),
    total: Number(doc.total ?? doc.amount ?? 0) || 0,
    currency: doc.currency_code != null ? String(doc.currency_code) : null,
    tax_treatment: doc.tax_treatment ? String(doc.tax_treatment) : null,
    payment_terms_id: doc.payment_terms_id != null
      ? String(doc.payment_terms_id)
      : null,
    has_po: hasPo,
    line_items: lines,
    documents: ((doc.documents as Array<Record<string, unknown>>) ?? []).map(
      (d) => ({
        file_name: d.file_name != null ? String(d.file_name) : null,
        file_type: d.file_type != null ? String(d.file_type) : null,
      }),
    ),
  };
}
