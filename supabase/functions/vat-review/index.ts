// VAT return (Form 201) pre-filing review. Recomputes the period's boxes
// from the actual documents in Zoho Books and lists what a filer must look
// at before submitting in the FTA portal. Reviews only — never files.
//
// Input: { period_end?: "yyyy-mm-dd" }  — defaults to the last COMPLETED
// VAT period per company_config (vat_period_months / vat_period_anchor_month).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createZohoMeter, meterContextFromRequest } from "../_shared/zoho_meter.ts";
import { isAuthFail, requireUser } from "../_shared/require_user.ts";
import { buildForm201, vatPeriodFor, type VatDoc } from "./form201.ts";
import { companyForCaller, isCompanyFail } from "../_shared/tenant.ts";
import { zohoAuthFor, type ZohoAuth } from "../_shared/zoho_auth.ts";

let zohoFetch: (url: string, init?: RequestInit) => Promise<Response> = fetch;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function requireEnv(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
function getSupabase(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * The company's own Zoho organisation and a token for it. This used to read
 * ZOHO_REFRESH_TOKEN and ZOHO_ORGANIZATION_ID from the environment, which is
 * one organisation for the whole deployment — see _shared/zoho_auth.ts.
 */
async function getAccessToken(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ZohoAuth> {
  return await zohoAuthFor(supabase, companyId);
}

async function zohoGet(z: ZohoAuth, path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ organization_id: z.organizationId, ...params });
  const res = await zohoFetch(`${z.apiBase}/${path}?${qs}`, { headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` } });
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Zoho ${path} failed (${res.status}): ${JSON.stringify(raw).slice(0, 200)}`);
  return raw as Record<string, unknown>;
}

/** List a document kind for the period, detail-fetching what the list view omits (capped). */
async function fetchDocs(
  z: ZohoAuth,
  kind: VatDoc["kind"],
  start: string,
  end: string,
  treatments: Map<string, string | null>,
  cap = 200,
): Promise<VatDoc[]> {
  const conf: Record<VatDoc["kind"], { path: string; listKey: string; idKey: string; numKey: string; detailKey: string; party: string; partyId: string }> = {
    invoice: { path: "invoices", listKey: "invoices", idKey: "invoice_id", numKey: "invoice_number", detailKey: "invoice", party: "customer_name", partyId: "customer_id" },
    creditnote: { path: "creditnotes", listKey: "creditnotes", idKey: "creditnote_id", numKey: "creditnote_number", detailKey: "creditnote", party: "customer_name", partyId: "customer_id" },
    bill: { path: "bills", listKey: "bills", idKey: "bill_id", numKey: "bill_number", detailKey: "bill", party: "vendor_name", partyId: "vendor_id" },
    vendorcredit: { path: "vendorcredits", listKey: "vendor_credits", idKey: "vendor_credit_id", numKey: "vendor_credit_number", detailKey: "vendor_credit", party: "vendor_name", partyId: "vendor_id" },
    expense: { path: "expenses", listKey: "expenses", idKey: "expense_id", numKey: "reference_number", detailKey: "expense", party: "vendor_name", partyId: "vendor_id" },
  };
  const c = conf[kind];
  const out: VatDoc[] = [];
  let page = 1;
  while (out.length < cap && page <= 5) {
    const raw = await zohoGet(z, c.path, { date_start: start, date_end: end, per_page: "200", page: String(page) });
    const rows = (raw[c.listKey] ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (out.length >= cap) break;
      const id = String(r[c.idKey] ?? "");
      if (!id) continue;
      // Expenses carry their split in the list view; the rest need the detail
      // for tax_total / place_of_supply / reverse charge.
      let subTotal: number, taxTotal: number, total: number, pos: string | null, rc: boolean, treatment: string | null;
      if (kind === "expense") {
        total = Number(r.total ?? 0) || 0;
        subTotal = Number(r.total_without_tax ?? total) || 0;
        taxTotal = Math.round((total - subTotal) * 100) / 100;
        pos = null; rc = Boolean(r.is_reverse_charge_applied ?? false);
        treatment = (r.tax_treatment as string | undefined) || treatments.get(String(r[c.partyId] ?? "")) || null;
      } else {
        const det = await zohoGet(z, `${c.path}/${id}`);
        const d = (det[c.detailKey] ?? {}) as Record<string, unknown>;
        subTotal = Number(d.sub_total ?? 0) || 0;
        taxTotal = Number(d.tax_total ?? 0) || 0;
        total = Number(d.total ?? 0) || 0;
        pos = (d.place_of_supply as string | undefined) || null;
        rc = Boolean(d.is_reverse_charge_applied ?? false);
        treatment = (d.tax_treatment as string | undefined) || treatments.get(String(r[c.partyId] ?? "")) || null;
      }
      out.push({
        kind, zoho_id: id, number: String(r[c.numKey] ?? id), date: String(r.date ?? "").slice(0, 10), status: String(r.status ?? ""),
        party_name: (r[c.party] as string | undefined) ?? null, tax_treatment: treatment,
        place_of_supply: pos, sub_total: subTotal, tax_total: taxTotal, total, is_reverse_charge: rc,
        currency: (r.currency_code as string | undefined) ?? null,
      });
    }
    const pc = (raw.page_context ?? {}) as Record<string, unknown>;
    if (!pc.has_more_page) break;
    page++;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const auth = await requireUser(req, { corsHeaders: CORS_HEADERS });
  if (isAuthFail(auth)) return auth.response;

  let input: { period_end?: string; company_id?: string } = {};
  try {
    const text = await req.text();
    input = text ? JSON.parse(text) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  // Runs with the service role, so nothing below checks who is asking
  // unless this does. No default company: a fallback is how a bug
  // becomes a cross-client leak instead of an error.
  const tenant = await companyForCaller(auth, {
    companyId: input.company_id ?? null,
    errorBody: (m) => ({ error: m }),
  });
  if (isCompanyFail(tenant)) return tenant.response;
  const companyId = tenant.companyId;
  const today = new Date().toISOString().slice(0, 10);

  try {
    const supabase = getSupabase();
    const meter = createZohoMeter(supabase, { ...meterContextFromRequest(req, "vat-review", "vat-review"), company_id: companyId });
    zohoFetch = meter.fetch;
    const token = await getAccessToken(supabase, companyId);

    const { data: config } = await supabase.from("company_config")
      .select("vat_period_months, vat_period_anchor_month, vat_filing_due_days")
      .eq("company_id", companyId).maybeSingle();
    const months = Number(config?.vat_period_months ?? 3);
    const anchor = Number(config?.vat_period_anchor_month ?? 3);
    const dueDays = Number(config?.vat_filing_due_days ?? 28);

    // Default period: the one containing period_end if given, else the last
    // COMPLETED period before today.
    let period = vatPeriodFor(input.period_end ?? today, months, anchor);
    if (!input.period_end && period.end >= today) {
      const prevEnd = new Date(`${period.start}T00:00:00Z`);
      prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
      period = vatPeriodFor(prevEnd.toISOString().slice(0, 10), months, anchor);
    }

    // Party treatments from the synced cache (list views often omit them).
    const { data: parties } = await supabase.from("zoho_entities").select("zoho_id, extra").in("kind", ["vendor", "customer"]);
    const treatments = new Map<string, string | null>((parties ?? []).map((p) => [String(p.zoho_id), ((p.extra as Record<string, unknown>)?.tax_treatment as string | undefined) ?? null]));

    // The org's TRN, from Zoho's own settings (the filer's identity).
    let orgTrn: string | null = null;
    try {
      const raw = await zohoGet(token, `organizations/${token.organizationId}`);
      const org = (raw.organization ?? {}) as Record<string, unknown>;
      orgTrn = (((org.tax_settings ?? {}) as Record<string, unknown>).tax_reg_no as string | undefined) || null;
    } catch { /* check reports it as missing */ }

    const docs: VatDoc[] = [];
    for (const kind of ["invoice", "creditnote", "bill", "vendorcredit", "expense"] as const) {
      docs.push(...await fetchDocs(token, kind, period.start, period.end, treatments));
    }

    const form = buildForm201(docs, { period_start: period.start, period_end: period.end, today, org_trn: orgTrn, due_days: dueDays });
    return jsonResponse({ ok: true, period_label: period.label, form, document_count: docs.length, usage: meter.summary() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("vat-review failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
