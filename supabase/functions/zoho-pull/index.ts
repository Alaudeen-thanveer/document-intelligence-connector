// Pull Zoho Books masters (chart of accounts, vendors, customers, reporting
// tags, currencies, projects, taxes, bank accounts, payment terms, items,
// users) into the local zoho_entities cache so the review UI can offer
// posting dropdowns.
// Read-only against Zoho; replaces cached rows per kind on each sync.
// Credentials come only from environment variables — never hardcoded.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createZohoMeter, meterContextFromRequest } from "../_shared/zoho_meter.ts";
import { isAuthFail, requireUser } from "../_shared/require_user.ts";

/** Set per request; every Zoho call goes through it so usage is metered. */
let zohoFetch: (url: string, init?: RequestInit) => Promise<Response> = fetch;

type EntityKind =
  | "account"
  | "vendor"
  | "customer"
  | "reporting_tag"
  | "currency"
  | "project"
  | "tax"
  | "bank_account"
  | "payment_term"
  | "item"
  | "user"
  | "bank_rule"
  | "purchase_order";

const ALL_KINDS: EntityKind[] = [
  "account",
  "vendor",
  "customer",
  "reporting_tag",
  "currency",
  "project",
  "tax",
  "bank_account",
  "payment_term",
  "item",
  "user",
  "bank_rule",
  "purchase_order",
];

interface PullInput {
  /** Which kinds to refresh; defaults to all. */
  kinds?: EntityKind[];
}

interface EntityRow {
  kind: EntityKind;
  zoho_id: string;
  name: string;
  extra: Record<string, unknown> | null;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info",
};

function jsonResponse(body: unknown, status = 200): Response {
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

function apiBase(): string {
  return (
    Deno.env.get("ZOHO_API_BASE_URL")?.trim() ||
    "https://www.zohoapis.com/books/v3"
  );
}

function orgId(): string {
  return requireEnv("ZOHO_ORGANIZATION_ID");
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

/** Best-effort write-through of the token cache (service-role only table). */
async function cacheAccessToken(token: string): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase.from("zoho_oauth_tokens").upsert({
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

async function getAccessToken(): Promise<string> {
  const existing = Deno.env.get("ZOHO_ACCESS_TOKEN")?.trim();
  if (existing) return existing;
  // Cached token when still valid — Zoho throttles the refresh endpoint
  // hard, and a refresh per function call locks the connection out.
  try {
    const supabase = getSupabase();
    const { data } = await supabase
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
    // Cache is an optimization only.
  }
  const token = await refreshAccessToken();
  await cacheAccessToken(token);
  return token;
}

/** Fetch every page of a Zoho list endpoint (per_page=200). */
async function fetchAllPages(
  accessToken: string,
  path: string,
  listKey: string,
  extraParams = "",
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let page = 1;

  while (page <= 25) {
    const url = `${apiBase()}/${path}?organization_id=${
      encodeURIComponent(orgId())
    }&per_page=200&page=${page}${extraParams}`;
    const res = await zohoFetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    const raw = await res.json();
    if (!res.ok) {
      throw new Error(
        `Zoho ${path} fetch failed (${res.status}): ${JSON.stringify(raw)}`,
      );
    }
    // Most list endpoints put the array at the top level; a few (e.g.
    // settings/paymentterms) nest it under a `data` object.
    const body = raw as Record<string, unknown>;
    const nested = (body.data as Record<string, unknown> | undefined) ?? {};
    const items =
      ((body[listKey] ?? nested[listKey]) as Array<
        Record<string, unknown>
      >) ?? [];
    out.push(...items);

    const hasMore = Boolean(
      (raw as { page_context?: { has_more_page?: boolean } }).page_context
        ?.has_more_page,
    );
    if (!hasMore) break;
    page++;
  }
  return out;
}

async function fetchKind(
  accessToken: string,
  kind: EntityKind,
): Promise<EntityRow[]> {
  if (kind === "account") {
    const accounts = await fetchAllPages(
      accessToken,
      "chartofaccounts",
      "chartofaccounts",
    );
    return accounts
      .map((a) => ({
        kind: "account" as const,
        zoho_id: String(a.account_id ?? ""),
        name: String(a.account_name ?? ""),
        extra: {
          account_type: a.account_type ?? null,
          is_active: a.is_active ?? null,
        },
      }))
      .filter((r) => r.zoho_id && r.name);
  }

  if (kind === "bank_rule") {
    // The org's own bank rules: explicit habits the bookkeeper wrote down.
    // Read as high-weight evidence for statement-line suggestions, and so
    // we never propose a rule that already exists.
    const list = await fetchAllPages(accessToken, "bankaccounts/rules", "rules");
    // The list view omits vendor_id / customer_id / auto_categorize (verified
    // live on the .ae DC) — enrich each rule from its detail. Rules are few.
    const rules: Array<Record<string, unknown>> = [];
    for (const l of list) {
      if (!l.rule_id) continue;
      try {
        const res = await zohoFetch(`${apiBase()}/bankaccounts/rules/${l.rule_id}?organization_id=${encodeURIComponent(orgId())}`, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
        const raw = await res.json() as { rule?: Record<string, unknown> };
        rules.push({ ...l, ...(raw.rule ?? {}) });
      } catch {
        rules.push(l);
      }
    }
    return rules
      .map((r) => ({
        kind: "bank_rule" as const,
        zoho_id: String(r.rule_id ?? ""),
        name: String(r.rule_name ?? ""),
        extra: {
          rule_category: r.rule_category ?? null,
          account_ids: r.account_ids ?? null,
          apply_to: r.apply_to ?? null, // deposits | withdrawals
          criteria_type: r.criteria_type ?? null, // and | or
          criterion: r.criterion ?? r.criterions ?? [],
          record_as: r.record_as ?? null,
          account_id: r.account_id ?? null,
          account_name: r.account_name ?? null,
          customer_id: r.customer_id ?? null,
          vendor_id: r.vendor_id ?? null,
          auto_categorize: r.auto_categorize ?? null, // autocategorize | recognize
          is_active: r.is_active ?? null,
          tax_id: r.tax_id ?? null,
        },
      }))
      .filter((r) => r.zoho_id && r.name);
  }

  if (kind === "purchase_order") {
    // Open purchase orders with their lines — the "what was ordered" side of
    // the three-way match. Only POs that can still be billed; capped.
    const list = await fetchAllPages(accessToken, "purchaseorders", "purchaseorders");
    const open = list.filter((p) => !/closed|cancelled|billed$/i.test(String(p.status ?? "")) && String(p.status ?? "") !== "draft").slice(0, 200);
    const rows: EntityRow[] = [];
    for (const p of open) {
      const id = String(p.purchaseorder_id ?? "");
      if (!id) continue;
      let lines: Array<Record<string, unknown>> = [];
      try {
        const res = await zohoFetch(`${apiBase()}/purchaseorders/${id}?organization_id=${encodeURIComponent(orgId())}`, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
        const raw = await res.json();
        lines = ((raw as { purchaseorder?: { line_items?: Array<Record<string, unknown>> } }).purchaseorder?.line_items ?? []).map((li) => ({
          line_item_id: li.line_item_id ?? null, name: li.name ?? null, description: li.description ?? null,
          quantity: li.quantity ?? null, quantity_billed: li.quantity_billed ?? null, quantity_cancelled: li.quantity_cancelled ?? null,
          rate: li.rate ?? null, item_total: li.item_total ?? null, account_id: li.account_id ?? null, account_name: li.account_name ?? null, tax_id: li.tax_id ?? null,
        }));
      } catch { /* list row is still useful */ }
      rows.push({
        kind: "purchase_order",
        zoho_id: id,
        name: String(p.purchaseorder_number ?? id),
        extra: {
          vendor_id: p.vendor_id ?? null, vendor_name: p.vendor_name ?? null, date: p.date ?? null,
          delivery_date: p.delivery_date ?? null, status: p.status ?? null, total: p.total ?? null, sub_total: p.sub_total ?? null,
          currency_code: p.currency_code ?? null, reference_number: p.reference_number ?? null, line_items: lines,
        },
      });
    }
    return rows;
  }

  if (kind === "reporting_tag") {
    // Note: the older `settings/tags` endpoint is retired (400 "no longer
    // available", verified on the .in DC); `reportingtags` returns { tags: [] }.
    const tags = await fetchAllPages(accessToken, "reportingtags", "tags");
    // The list view carries no options; they live on the detail endpoint.
    // Options are what a bill/invoice line actually gets tagged with, so
    // fetch each tag's detail (tags are few — a handful per org).
    const rows: EntityRow[] = [];
    for (const t of tags) {
      const id = String(t.tag_id ?? "");
      const name = String(t.tag_name ?? "");
      if (!id || !name) continue;
      let options: Array<{ id: string | null; name: string | null }> = [];
      // Zoho: a tag is applied per line item or once per transaction.
      // Default to line_item; the detail endpoint says which.
      let preference: "line_item" | "transaction" = "line_item";
      let isDraft: unknown = t.is_draft ?? null;
      try {
        const detailUrl = `${apiBase()}/reportingtags/${id}?organization_id=${
          encodeURIComponent(orgId())
        }`;
        const res = await zohoFetch(detailUrl, {
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        });
        const raw = await res.json();
        const tag = (raw as { tag?: Record<string, unknown> })?.tag ?? {};
        const pref = (tag.multi_preference_entities as
          | { preference?: unknown }
          | undefined)?.preference;
        if (pref === "transaction") preference = "transaction";
        if (tag.is_draft != null) isDraft = tag.is_draft;
        const opts = (tag.tag_options ?? t.tag_options) as
          | Array<Record<string, unknown>>
          | undefined;
        options = Array.isArray(opts)
          ? opts.map((o) => ({
            id: o.tag_option_id != null ? String(o.tag_option_id) : null,
            name: o.tag_option_name != null ? String(o.tag_option_name) : null,
          }))
          : [];
      } catch (err) {
        console.warn(
          `reporting tag ${id} detail failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      rows.push({
        kind: "reporting_tag",
        zoho_id: id,
        name,
        extra: {
          is_active: t.is_active ?? null,
          is_draft: isDraft,
          // "line_item" → one value per line; "transaction" → one value for
          // the whole document, applied uniformly to every line on push.
          preference,
          options,
        },
      });
    }
    return rows;
  }

  if (kind === "currency") {
    const currencies = await fetchAllPages(
      accessToken,
      "settings/currencies",
      "currencies",
    );
    return currencies
      .map((c) => ({
        kind: "currency" as const,
        zoho_id: String(c.currency_id ?? ""),
        name: String(c.currency_code ?? c.currency_name ?? ""),
        extra: {
          currency_name: c.currency_name ?? null,
          symbol: c.currency_symbol ?? null,
          is_base_currency: c.is_base_currency ?? null,
          exchange_rate: c.exchange_rate ?? null,
        },
      }))
      .filter((r) => r.zoho_id && r.name);
  }

  if (kind === "project") {
    const projects = await fetchAllPages(accessToken, "projects", "projects");
    return projects
      .map((p) => ({
        kind: "project" as const,
        zoho_id: String(p.project_id ?? ""),
        name: String(p.project_name ?? ""),
        extra: {
          customer_id: p.customer_id != null ? String(p.customer_id) : null,
          customer_name: p.customer_name ?? null,
          status: p.status ?? null,
        },
      }))
      .filter((r) => r.zoho_id && r.name);
  }

  if (kind === "tax") {
    const taxes = await fetchAllPages(accessToken, "settings/taxes", "taxes");
    return taxes
      .map((t) => ({
        kind: "tax" as const,
        zoho_id: String(t.tax_id ?? ""),
        name: String(t.tax_name ?? ""),
        extra: {
          percentage: t.tax_percentage ?? null,
          tax_type: t.tax_type ?? null,
        },
      }))
      .filter((r) => r.zoho_id && r.name);
  }

  if (kind === "bank_account") {
    const banks = await fetchAllPages(
      accessToken,
      "bankaccounts",
      "bankaccounts",
    );
    return banks
      .map((b) => ({
        kind: "bank_account" as const,
        zoho_id: String(b.account_id ?? ""),
        name: String(b.account_name ?? ""),
        extra: {
          account_type: b.account_type ?? null,
          currency_code: b.currency_code ?? null,
          is_active: b.is_active ?? null,
        },
      }))
      .filter((r) => r.zoho_id && r.name);
  }

  if (kind === "payment_term") {
    const terms = await fetchAllPages(
      accessToken,
      "settings/paymentterms",
      "payment_terms",
    );
    return terms
      .map((t) => ({
        kind: "payment_term" as const,
        zoho_id: String(t.payment_terms_id ?? ""),
        name: String(
          t.payment_terms_label ??
            (t.payment_terms != null ? `Net ${t.payment_terms}` : ""),
        ),
        extra: {
          days: t.payment_terms ?? null,
        },
      }))
      .filter((r) => r.zoho_id && r.name);
  }

  if (kind === "item") {
    const items = await fetchAllPages(accessToken, "items", "items");
    return items
      .map((i) => ({
        kind: "item" as const,
        zoho_id: String(i.item_id ?? ""),
        name: String(i.name ?? ""),
        extra: {
          rate: i.rate ?? null,
          status: i.status ?? null,
          product_type: i.product_type ?? null,
        },
      }))
      .filter((r) => r.zoho_id && r.name);
  }

  if (kind === "user") {
    const users = await fetchAllPages(accessToken, "users", "users");
    return users
      .map((u) => ({
        kind: "user" as const,
        zoho_id: String(u.user_id ?? ""),
        name: String(u.name ?? ""),
        extra: {
          email: u.email ?? null,
          role: u.user_role ?? u.role_id ?? null,
          status: u.status ?? null,
        },
      }))
      .filter((r) => r.zoho_id && r.name);
  }

  const contacts = await fetchAllPages(
    accessToken,
    "contacts",
    "contacts",
    `&contact_type=${kind}`,
  );
  // The list view has tax_treatment but NOT the TRN (tax_reg_no) — that
  // lives only in the contact detail (verified on the .ae DC). The TRN is
  // needed for the e-invoice readiness check (buyer TRN on B2B) and the
  // Form 201 review, so enrich a bounded number of contacts per sync.
  const detailByContact = new Map<string, Record<string, unknown>>();
  for (const c of contacts.slice(0, 300)) {
    const id = String(c.contact_id ?? "");
    if (!id) continue;
    try {
      const res = await zohoFetch(`${apiBase()}/contacts/${id}?organization_id=${encodeURIComponent(orgId())}`, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
      const raw = await res.json() as { contact?: Record<string, unknown> };
      const d = raw.contact ?? {};
      detailByContact.set(id, {
        tax_reg_no: (d.tax_reg_no as string | undefined) || null,
        // Credit control: Zoho's own limit (0/absent when the org has the
        // feature off), the open balance, and the credit they hold.
        credit_limit: d.credit_limit != null && Number(d.credit_limit) > 0 ? Number(d.credit_limit) : null,
        outstanding_receivable: d.outstanding_receivable_amount != null ? Number(d.outstanding_receivable_amount) : null,
        unused_credits_receivable: d.unused_credits_receivable_amount != null ? Number(d.unused_credits_receivable_amount) : null,
        email: (d.email as string | undefined) || null,
      });
    } catch { /* detail stays unknown for this contact */ }
  }
  return contacts
    .map((c) => ({
      kind,
      zoho_id: String(c.contact_id ?? ""),
      name: String(c.contact_name ?? c.company_name ?? ""),
      extra: {
        company_name: c.company_name ?? null,
        status: c.status ?? null,
        // Party-level default only; treatment is decided per transaction at
        // push time (a VAT-registered party can have an out-of-scope bill).
        tax_treatment: c.tax_treatment || null,
        // UAE VAT: Zoho requires place_of_supply on sales invoices; the
        // contact's emirate (place_of_contact) is the default source.
        place_of_contact: c.place_of_contact || null,
        // TRN (15 digits when real); null when not registered / not entered.
        // Plus the credit-control fields from the same detail fetch.
        ...(detailByContact.get(String(c.contact_id ?? "")) ?? { tax_reg_no: null }),
      },
    }))
    .filter((r) => r.zoho_id && r.name);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const auth = await requireUser(req);
  if (isAuthFail(auth)) return auth.response;

  const companyId =
    typeof auth.user?.app_metadata?.company_id === "string" &&
      auth.user.app_metadata.company_id.trim()
      ? auth.user.app_metadata.company_id.trim()
      : null;
  if (!companyId) {
    return jsonResponse(
      {
        ok: false,
        error:
          "No company_id on this account. Set app_metadata.company_id / company_members, then sign out/in.",
      },
      403,
    );
  }

  let input: PullInput = {};
  try {
    const text = await req.text();
    input = text ? (JSON.parse(text) as PullInput) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const kinds: EntityKind[] =
    input.kinds && input.kinds.length > 0 ? input.kinds : ALL_KINDS;

  try {
    const supabase = getSupabase();
    const meter = createZohoMeter(
      supabase,
      meterContextFromRequest(req, "sync", "zoho-pull"),
    );
    zohoFetch = meter.fetch;
    let accessToken = await getAccessToken();
    const counts: Record<string, number> = {};

    for (const kind of kinds) {
      let rows: EntityRow[];
      try {
        rows = await fetchKind(accessToken, kind);
      } catch (err) {
        // One retry with a fresh token on auth/transient failure.
        const msg = err instanceof Error ? err.message : String(err);
        if (/\((401|403|5\d\d)\)/.test(msg)) {
          console.log(`zoho-pull ${kind} failed (${msg}); retrying once`);
          accessToken = await refreshAccessToken();
          await cacheAccessToken(accessToken);
          rows = await fetchKind(accessToken, kind);
        } else {
          throw err;
        }
      }

      // Replace the cache for this kind for this company only.
      const { error: delError } = await supabase
        .from("zoho_entities")
        .delete()
        .eq("kind", kind)
        .eq("company_id", companyId);
      if (delError) {
        throw new Error(`zoho_entities delete failed: ${delError.message}`);
      }

      if (rows.length > 0) {
        const { error: insError } = await supabase
          .from("zoho_entities")
          .insert(rows.map((r) => ({ ...r, company_id: companyId })));
        if (insError) {
          throw new Error(`zoho_entities insert failed: ${insError.message}`);
        }
      }
      counts[kind] = rows.length;
    }

    return jsonResponse({ ok: true, counts, usage: meter.summary() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("zoho-pull failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
