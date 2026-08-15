// Month-end nudges: what a human should look at before closing a period.
// Reads Zoho recurring-journal definitions + journals posted in the month,
// and the expected-but-missing checks a reviewer ENABLED. Lists only —
// this function never posts, creates, or changes anything, in Zoho or here.
//
// Input: { month?: "yyyy-mm" }  (default: current month)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  type EnabledExpectedMissing,
  type EnabledJournalPattern,
  type EnabledLaterThanUsual,
  expectedBillNudges,
  journalPatternNudges,
  laterThanUsualNudges,
  type OpenDoc,
  type PostedJournal,
  type PostedJournalWithFingerprint,
  type RecurringJournalDef,
  recurringJournalNudges,
  type SeenBill,
} from "./nudges.ts";

/** Same fingerprint as bookkeeping-learn/journal_patterns.ts. */
function fingerprintLines(
  lines: Array<{ account_id: string; debit: number; credit: number }>,
): string {
  const parts = new Set<string>();
  for (const l of lines) {
    if (!l.account_id) continue;
    if (l.debit > 0) parts.add(`${l.account_id}:D`);
    if (l.credit > 0) parts.add(`${l.account_id}:C`);
  }
  return [...parts].sort().join("+");
}

const DEFAULT_COMPANY = "00000000-0000-4000-8000-000000000001";
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
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
function getSupabase(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
function apiBase(): string {
  return Deno.env.get("ZOHO_API_BASE_URL")?.trim() || "https://www.zohoapis.com/books/v3";
}

async function getAccessToken(supabase: SupabaseClient): Promise<string> {
  const existing = Deno.env.get("ZOHO_ACCESS_TOKEN")?.trim();
  if (existing) return existing;
  const { data } = await supabase.from("zoho_oauth_tokens")
    .select("access_token, expires_at").eq("id", 1).maybeSingle();
  if (data?.access_token && new Date(String(data.expires_at)).getTime() > Date.now() + 120_000) {
    return String(data.access_token);
  }
  const accountsUrl = Deno.env.get("ZOHO_ACCOUNTS_URL")?.trim() || "https://accounts.zoho.com";
  const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: requireEnv("ZOHO_REFRESH_TOKEN"),
      client_id: requireEnv("ZOHO_CLIENT_ID"),
      client_secret: requireEnv("ZOHO_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  const payload = await res.json();
  if (!res.ok || !payload?.access_token) {
    throw new Error(`Zoho token refresh failed (${res.status}): ${JSON.stringify(payload)}`);
  }
  const token = String(payload.access_token);
  await supabase.from("zoho_oauth_tokens").upsert({
    id: 1, access_token: token,
    expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  return token;
}

async function zohoGet(token: string, path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams({ organization_id: requireEnv("ZOHO_ORGANIZATION_ID"), ...params });
  const res = await fetch(`${apiBase()}/${path}?${qs}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Zoho ${path} failed (${res.status}): ${JSON.stringify(raw)}`);
  return raw as Record<string, unknown>;
}

function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let input: { month?: string; company_id?: string } = {};
  try {
    const text = await req.text();
    input = text ? JSON.parse(text) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const today = new Date().toISOString().slice(0, 10);
  const month = /^\d{4}-\d{2}$/.test(input.month ?? "") ? input.month! : today.slice(0, 7);
  const companyId = input.company_id ?? DEFAULT_COMPANY;
  const { start, end } = monthBounds(month);

  try {
    const supabase = getSupabase();
    const token = await getAccessToken(supabase);

    // --- Recurring journals: definitions + what was posted this month ---
    const rjRaw = await zohoGet(token, "recurringjournals");
    const defs: RecurringJournalDef[] = (
      (rjRaw.recurring_journals ?? rjRaw.recurringjournals ?? []) as Array<Record<string, unknown>>
    ).map((r) => ({
      recurring_journal_id: String(r.recurring_journal_id ?? ""),
      recurrence_name: String(r.recurrence_name ?? ""),
      recurrence_frequency: String(r.recurrence_frequency ?? "months"),
      repeat_every: Number(r.repeat_every ?? 1) || 1,
      start_date: String(r.start_date ?? "").slice(0, 10),
      end_date: r.end_date ? String(r.end_date).slice(0, 10) : null,
      status: String(r.status ?? "active"),
      total: r.total != null ? Number(r.total) : null,
      next_journal_date: r.next_journal_date ? String(r.next_journal_date).slice(0, 10) : null,
      last_journal_date: r.last_journal_date ? String(r.last_journal_date).slice(0, 10) : null,
    })).filter((d) => d.recurring_journal_id);

    // Zoho's journals list ignores journal_date_start/end but honours
    // date_start/end (verified on the .ae DC).
    const jRaw = await zohoGet(token, "journals", {
      date_start: start,
      date_end: end,
      per_page: "200",
    });
    const posted: PostedJournal[] = ((jRaw.journals ?? []) as Array<Record<string, unknown>>)
      .map((j) => ({
        journal_id: String(j.journal_id ?? ""),
        journal_date: String(j.journal_date ?? j.date ?? "").slice(0, 10),
        reference_number: j.reference_number != null ? String(j.reference_number) : null,
        notes: j.notes != null ? String(j.notes) : null,
        total: j.total != null ? Number(j.total) : null,
      }));

    // --- Expected bills: ENABLED checks only ---
    const { data: enabledRows } = await supabase
      .from("bk_check_proposals")
      .select("party_zoho_id, party_name, params")
      .eq("company_id", companyId)
      .eq("party_kind", "vendor")
      .eq("check_kind", "expected_missing")
      .eq("status", "enabled");
    const enabled: EnabledExpectedMissing[] = (enabledRows ?? []).map((r) => {
      const p = (r.params ?? {}) as Record<string, unknown>;
      return {
        party_zoho_id: String(r.party_zoho_id),
        party_name: String(r.party_name),
        next_expected: p.next_expected != null ? String(p.next_expected) : null,
        day_min: p.day_min != null ? Number(p.day_min) : null,
        day_max: p.day_max != null ? Number(p.day_max) : null,
      };
    });

    // Bills seen this month: local extracted history (what the app processed)
    // plus Zoho bills for the period (what is actually in the books).
    const seen: SeenBill[] = [];
    if (enabled.length > 0) {
      const { data: docs } = await supabase
        .from("documents").select("id").eq("company_id", companyId);
      const ids = (docs ?? []).map((d) => d.id as string);
      if (ids.length) {
        const { data: ex } = await supabase
          .from("extracted_fields")
          .select("vendor_raw, invoice_date")
          .in("document_id", ids)
          .gte("invoice_date", start)
          .lte("invoice_date", end);
        for (const e of ex ?? []) {
          seen.push({ vendor_zoho_id: null, vendor_name: e.vendor_raw as string | null, invoice_date: e.invoice_date as string | null });
        }
      }
      const bRaw = await zohoGet(token, "bills", { date_start: start, date_end: end, per_page: "200" });
      for (const b of (bRaw.bills ?? []) as Array<Record<string, unknown>>) {
        seen.push({
          vendor_zoho_id: b.vendor_id != null ? String(b.vendor_id) : null,
          vendor_name: b.vendor_name != null ? String(b.vendor_name) : null,
          invoice_date: String(b.date ?? "").slice(0, 10),
        });
      }
    }

    // --- Layer 5: ENABLED undeclared recurring journals, matched by
    // fingerprint against journals posted this month (detail fetch needed
    // for line items; only for the month's journals, so cheap).
    const { data: jpRows } = await supabase
      .from("bk_journal_patterns")
      .select("fingerprint, label, cadence, amount_median, expected_day_min, expected_day_max")
      .eq("company_id", companyId)
      .eq("status", "enabled");
    const enabledPatterns = (jpRows ?? []) as EnabledJournalPattern[];
    let postedWithFp: PostedJournalWithFingerprint[] = [];
    if (enabledPatterns.length > 0 && posted.length > 0) {
      for (const p of posted) {
        try {
          const det = await zohoGet(token, `journals/${p.journal_id}`);
          const j = (det.journal ?? det) as Record<string, unknown>;
          const lines = ((j.line_items as Array<Record<string, unknown>>) ?? []).map((li) => {
            const side = String(li.debit_or_credit ?? "").toLowerCase();
            const amt = Number(li.amount ?? 0) || 0;
            return {
              account_id: String(li.account_id ?? ""),
              debit: Number(li.debit_amount ?? 0) || (side === "debit" ? amt : 0),
              credit: Number(li.credit_amount ?? 0) || (side === "credit" ? amt : 0),
            };
          });
          postedWithFp.push({ ...p, fingerprint: fingerprintLines(lines) });
        } catch {
          postedWithFp.push({ ...p, fingerprint: "" });
        }
      }
    }

    // --- Layer 6: ENABLED later-than-usual — open bills/invoices for those
    // parties, from Zoho (the books are the truth for balances).
    const { data: ltuRows } = await supabase
      .from("bk_check_proposals")
      .select("party_kind, party_zoho_id, party_name, params")
      .eq("company_id", companyId)
      .eq("check_kind", "later_than_usual")
      .eq("status", "enabled");
    const enabledLtu: EnabledLaterThanUsual[] = (ltuRows ?? [])
      .map((r) => {
        const p = (r.params ?? {}) as Record<string, unknown>;
        return {
          party_kind: r.party_kind as "vendor" | "customer",
          party_zoho_id: String(r.party_zoho_id),
          party_name: String(r.party_name),
          pay_lag_p90: Number(p.pay_lag_p90),
          pay_lag_median: p.pay_lag_median != null ? Number(p.pay_lag_median) : null,
        };
      })
      .filter((e) => Number.isFinite(e.pay_lag_p90));
    const openDocs: OpenDoc[] = [];
    if (enabledLtu.length > 0) {
      const wantBills = enabledLtu.some((e) => e.party_kind === "vendor");
      const wantInvoices = enabledLtu.some((e) => e.party_kind === "customer");
      if (wantBills) {
        const b = await zohoGet(token, "bills", { status: "unpaid", per_page: "200" });
        for (const x of (b.bills ?? []) as Array<Record<string, unknown>>) {
          openDocs.push({
            doc_kind: "bill", zoho_id: String(x.bill_id ?? ""), number: x.bill_number != null ? String(x.bill_number) : null,
            party_zoho_id: String(x.vendor_id ?? ""), date: String(x.date ?? "").slice(0, 10), balance: Number(x.balance ?? 0) || 0,
          });
        }
      }
      if (wantInvoices) {
        const i = await zohoGet(token, "invoices", { status: "unpaid", per_page: "200" });
        for (const x of (i.invoices ?? []) as Array<Record<string, unknown>>) {
          openDocs.push({
            doc_kind: "invoice", zoho_id: String(x.invoice_id ?? ""), number: x.invoice_number != null ? String(x.invoice_number) : null,
            party_zoho_id: String(x.customer_id ?? ""), date: String(x.date ?? "").slice(0, 10), balance: Number(x.balance ?? 0) || 0,
          });
        }
      }
    }

    const nudges = [
      ...recurringJournalNudges(defs, posted, month),
      ...journalPatternNudges(enabledPatterns, postedWithFp, month),
      ...expectedBillNudges(enabled, seen, month, today),
      ...laterThanUsualNudges(enabledLtu, openDocs, today),
    ];
    const attention = nudges.filter((n) => n.severity === "attention");

    return jsonResponse({
      ok: true,
      month,
      today,
      summary: {
        recurring_journal_definitions: defs.length,
        journals_posted_this_month: posted.length,
        expected_bill_checks_enabled: enabled.length,
        journal_patterns_enabled: enabledPatterns.length,
        later_than_usual_enabled: enabledLtu.length,
        needs_attention: attention.length,
      },
      nudges,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("month-end failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
