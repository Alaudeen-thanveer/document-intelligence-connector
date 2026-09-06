// Cash: collections (ageing + who to chase + Zoho payment reminders),
// payment run (proposed batch → vendor payments on approval), and the
// credit-watch list. Every outward action is one human click, audited.
//
// Actions:
//   collections     → { ageing, chase[], over_limit[] }
//   send_reminder   → { invoice_id }  POST Zoho's own payment reminder email
//   payment_run     → { groups[] } proposed batch (overdue + due within horizon)
//   record_payments → { payments: [{vendor_id, date, paid_through_account_id, bills:[{bill_id, amount_applied}]}] }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createZohoMeter, meterContextFromRequest } from "../_shared/zoho_meter.ts";
import { isAuthFail, requireUser } from "../_shared/require_user.ts";
import { fetchOpenCredits, fetchOpenDocuments } from "../bank-statement/suggest.ts";
import { ageInvoices, buildChaseList, buildPaymentRun, creditCheck, validatePayment, type OpenInvoiceLike, type PayBehaviour } from "./cash.ts";
import { companyForCaller, isCompanyFail } from "../_shared/tenant.ts";
import { zohoAuthFor, type ZohoAuth } from "../_shared/zoho_auth.ts";

let zohoFetch: typeof fetch = fetch;

const CORS_HEADERS = corsHeaders("authorization, content-type, apikey, x-client-info");
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

async function zohoPost(z: ZohoAuth, path: string, body: unknown): Promise<{ ok: boolean; status: number; raw: Record<string, unknown> }> {
  const qs = new URLSearchParams({ organization_id: z.organizationId });
  const res = await zohoFetch(`${z.apiBase}/${path}?${qs}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const raw = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: res.ok && (raw.code == null || raw.code === 0), status: res.status, raw };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const auth = await requireUser(req, { corsHeaders: CORS_HEADERS });
  if (isAuthFail(auth)) return auth.response;

  let input: {
    action?: "collections" | "send_reminder" | "payment_run" | "record_payments";
    company_id?: string;
    invoice_id?: string;
    payments?: Array<{ vendor_id: string; date: string; paid_through_account_id: string; reference?: string | null; bills: Array<{ bill_id: string; amount_applied: number }> }>;
  } = {};
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
  const action = input.action ?? "collections";
  const today = new Date().toISOString().slice(0, 10);
  const actor = (auth.user?.email as string | undefined) ?? "reviewer";

  try {
    const supabase = getSupabase();
    const meter = createZohoMeter(supabase, { ...meterContextFromRequest(req, "cashflow", `cashflow-${action}`), company_id: companyId });
    zohoFetch = meter.fetch;
    const z = await getAccessToken(supabase, companyId);
    const orgId = z.organizationId;
    const { data: cfg } = await supabase.from("company_config")
      .select("payment_run_horizon_days, credit_limits, locked_until")
      .eq("company_id", companyId).maybeSingle();
    const lockedUntil = cfg?.locked_until ? String(cfg.locked_until) : null;
    const audit = (act: string, detail: Record<string, unknown>) =>
      supabase.from("audit_log").insert({ company_id: companyId, actor_type: "human", actor_id: auth.user?.id ?? null, action: act, detail: { ...detail, actor } }).then(() => {}, () => {});

    // ------------------------------------------------------ collections
    if (action === "collections") {
      const docs = await fetchOpenDocuments(zohoFetch, z.apiBase, orgId, z.accessToken);
      const invoices = docs.filter((d) => d.kind === "invoice") as unknown as OpenInvoiceLike[];
      // Learned payment habits (layer 6) — any status; evidence, not a rule.
      const { data: lagRows } = await supabase.from("bk_check_proposals")
        .select("party_zoho_id, params").eq("company_id", companyId)
        .eq("check_kind", "later_than_usual").eq("party_kind", "customer");
      const behaviours: PayBehaviour[] = (lagRows ?? []).map((r) => {
        const p = (r.params ?? {}) as Record<string, unknown>;
        return { party_zoho_id: String(r.party_zoho_id), pay_lag_median: p.pay_lag_median != null ? Number(p.pay_lag_median) : null, pay_lag_p90: Number(p.pay_lag_p90) };
      }).filter((b) => Number.isFinite(b.pay_lag_p90));
      const ageing = ageInvoices(invoices, today);
      const chase = buildChaseList(invoices, behaviours, today);
      // Credit watch: exposure per customer vs limit (Zoho's field when on, else the app map).
      const { data: customers } = await supabase.from("zoho_entities").select("zoho_id, name, extra").eq("kind", "customer");
      const limits = (cfg?.credit_limits ?? {}) as Record<string, number>;
      const openByCustomer = new Map<string, number>();
      for (const inv of invoices) openByCustomer.set(inv.party_zoho_id, (openByCustomer.get(inv.party_zoho_id) ?? 0) + inv.balance);
      const overLimit = [] as Array<Record<string, unknown>>;
      for (const c of customers ?? []) {
        const outstanding = openByCustomer.get(String(c.zoho_id)) ?? 0;
        const extra = (c.extra as Record<string, unknown>) ?? {};
        const result = creditCheck({
          customer_name: String(c.name), zoho_credit_limit: extra.credit_limit != null ? Number(extra.credit_limit) : null,
          app_credit_limit: limits[String(c.zoho_id)] != null ? Number(limits[String(c.zoho_id)]) : null,
          outstanding, unused_credits: 0, invoice_total: 0,
        });
        if (result.applicable && (result.over || (result.headroom_before ?? Infinity) < outstanding * 0.25)) {
          overLimit.push({ customer_zoho_id: c.zoho_id, customer_name: c.name, ...result });
        }
      }
      return jsonResponse({ ok: true, today, ageing, chase, over_limit: overLimit, behaviours_known: behaviours.length, usage: meter.summary() });
    }

    // --------------------------------------------------- send_reminder
    // Zoho sends its own payment-reminder email for ONE invoice, on one
    // human click. Nothing here is scheduled or bulk.
    if (action === "send_reminder") {
      const invoiceId = String(input.invoice_id ?? "");
      if (!invoiceId) return jsonResponse({ ok: false, error: "invoice_id required" }, 400);
      // The endpoint needs the recipients spelled out (verified live — an
      // empty body fails with a misleading "email not found"). Recipients
      // come from the invoice's own contact persons, else the contact email.
      const detQs = new URLSearchParams({ organization_id: orgId });
      const detRes = await zohoFetch(`${z.apiBase}/invoices/${invoiceId}?${detQs}`, { headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` } });
      const det = await detRes.json().catch(() => ({})) as { invoice?: Record<string, unknown> };
      const inv = det.invoice ?? {};
      const persons = ((inv.contact_persons_details ?? []) as Array<Record<string, unknown>>).map((p) => String(p.email ?? "")).filter(Boolean);
      const to = persons.length ? persons : (inv.email ? [String(inv.email)] : []);
      if (!to.length) {
        return jsonResponse({ ok: false, error: `${inv.customer_name ?? "The customer"} has no email on file in Zoho Books — add a contact person with an email, then send the reminder.` }, 422);
      }
      let res = await zohoPost(z, `invoices/${invoiceId}/paymentreminder`, { to_mail_ids: to });
      if (!res.ok) {
        // Some editions also want the wording; keep it factual and neutral.
        const due = inv.due_date ? String(inv.due_date) : null;
        res = await zohoPost(z, `invoices/${invoiceId}/paymentreminder`, {
          to_mail_ids: to,
          subject: `Payment reminder: invoice ${inv.invoice_number ?? ""}`.trim(),
          body: `Dear customer,

A gentle reminder that invoice ${inv.invoice_number ?? invoiceId} for ${inv.currency_code ?? ""} ${Number(inv.balance ?? 0).toFixed(2)}${due ? ` was due on ${due}` : " is outstanding"}. Kindly arrange payment at your convenience.

Thank you.`,
        });
      }
      if (!res.ok) return jsonResponse({ ok: false, error: `Zoho did not send the reminder: ${res.raw.message ?? res.status}` }, 502);
      await audit("payment_reminder_sent", { invoice_zoho_id: invoiceId, to, zoho_message: res.raw.message ?? null });
      return jsonResponse({ ok: true, message: String(res.raw.message ?? "Reminder sent."), to, usage: meter.summary() });
    }

    // ----------------------------------------------------- payment_run
    if (action === "payment_run") {
      const docs = await fetchOpenDocuments(zohoFetch, z.apiBase, orgId, z.accessToken);
      const bills = docs.filter((d) => d.kind === "bill") as unknown as OpenInvoiceLike[];
      const credits = await fetchOpenCredits(zohoFetch, z.apiBase, orgId, z.accessToken);
      const unused = credits.filter((c) => c.party_kind === "vendor").map((c) => ({ party_zoho_id: c.party_zoho_id, kind: c.kind, number: c.number, balance: c.balance }));
      const groups = buildPaymentRun(bills, { today, horizon_days: Number(cfg?.payment_run_horizon_days ?? 7), unused_credits: unused });
      const { data: bankAccounts } = await supabase.from("zoho_entities").select("zoho_id, name, extra").eq("kind", "bank_account");
      return jsonResponse({ ok: true, today, horizon_days: Number(cfg?.payment_run_horizon_days ?? 7), groups, bank_accounts: (bankAccounts ?? []).filter((b) => ((b.extra as Record<string, unknown>)?.is_active ?? true) !== false), locked_until: lockedUntil, usage: meter.summary() });
    }

    // ------------------------------------------------- record_payments
    // The approved batch. Amounts are re-validated against the CURRENT open
    // bills — the client's numbers are never trusted.
    if (action === "record_payments") {
      const payments = Array.isArray(input.payments) ? input.payments : [];
      if (!payments.length) return jsonResponse({ ok: false, error: "No payments in the batch." }, 400);
      const docs = await fetchOpenDocuments(zohoFetch, z.apiBase, orgId, z.accessToken);
      const openBills = docs.filter((d) => d.kind === "bill") as unknown as OpenInvoiceLike[];
      const results: Array<Record<string, unknown>> = [];
      let recorded = 0, failed = 0;
      for (const p of payments) {
        const v = validatePayment({ vendor_id: String(p.vendor_id), date: String(p.date), bills: (p.bills ?? []).map((b) => ({ bill_id: String(b.bill_id), amount_applied: Number(b.amount_applied) })) }, openBills, { today, locked_until: lockedUntil });
        if (!v.ok) { results.push({ vendor_id: p.vendor_id, ok: false, error: v.error }); failed++; continue; }
        if (!p.paid_through_account_id) { results.push({ vendor_id: p.vendor_id, ok: false, error: "Pick the bank account the payment goes out of." }); failed++; continue; }
        const res = await zohoPost(z, "vendorpayments", {
          vendor_id: p.vendor_id, amount: v.total, date: p.date, payment_mode: "banktransfer",
          paid_through_account_id: p.paid_through_account_id,
          ...(p.reference ? { reference_number: String(p.reference).slice(0, 50) } : {}),
          bills: p.bills.map((b) => ({ bill_id: b.bill_id, amount_applied: Math.round(Number(b.amount_applied) * 100) / 100 })),
        });
        if (!res.ok) { results.push({ vendor_id: p.vendor_id, vendor_name: v.vendor_name, ok: false, error: String(res.raw.message ?? res.status) }); failed++; continue; }
        const payment = (res.raw.vendorpayment ?? res.raw.payment ?? {}) as Record<string, unknown>;
        const zohoId = payment.payment_id ? String(payment.payment_id) : null;
        // audit_log is also the "recorded through our app" ledger the bank
        // statement engine reads, so the eventual statement line links
        // instead of double-recording.
        await audit("vendor_payment_recorded", { vendor_zoho_id: p.vendor_id, vendor_name: v.vendor_name, amount: v.total, date: p.date, bills: p.bills.length, zoho_payment_id: zohoId });
        results.push({ vendor_id: p.vendor_id, vendor_name: v.vendor_name, ok: true, zoho_payment_id: zohoId, amount: v.total });
        recorded++;
      }
      return jsonResponse({ ok: failed === 0, recorded, failed, results, usage: meter.summary() }, failed && !recorded ? 422 : 200);
    }

    return jsonResponse({ ok: false, error: `Unknown action ${action}` }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("cashflow failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
