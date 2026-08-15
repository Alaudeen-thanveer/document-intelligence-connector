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
  expectedBillNudges,
  type PostedJournal,
  type RecurringJournalDef,
  recurringJournalNudges,
  type SeenBill,
} from "./nudges.ts";

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

    const jRaw = await zohoGet(token, "journals", {
      journal_date_start: start,
      journal_date_end: end,
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

    const nudges = [
      ...recurringJournalNudges(defs, posted, month),
      ...expectedBillNudges(enabled, seen, month, today),
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
