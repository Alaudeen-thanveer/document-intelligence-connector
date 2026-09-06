// Admin API-usage dashboard data.
//
// Zoho sends no rate-limit headers, so the app counts its own calls
// (zoho_api_calls, written by the meter in every function). This function
// combines that log with:
//   • the org's plan, read live from GET /organizations (plan_name), and
//   • Zoho Books' PUBLISHED limits per plan (source: zoho.com/books/api/v3
//     "API Call Limit"), which are fixed by Zoho, not by us.
//
// Input: { window_days?: number }  (default 7 — for the per-day chart)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createZohoMeter, meterContextFromRequest } from "../_shared/zoho_meter.ts";
import { isAuthFail, requireUser } from "../_shared/require_user.ts";
import { companyForCaller, isCompanyFail } from "../_shared/tenant.ts";
import { zohoAuthFor, type ZohoAuth } from "../_shared/zoho_auth.ts";

const CORS_HEADERS = corsHeaders();

/**
 * Zoho Books published API limits (zoho.com/books/api/v3, "API Call Limit").
 * Per-minute is the same for every plan; per-day and concurrency vary.
 * If Zoho changes these, this table is the only place to update.
 */
const ZOHO_LIMITS = {
  per_minute_all_plans: 100,
  per_day: {
    free: 1000,
    standard: 2000,
    professional: 5000,
    premium: 10000,
    elite: 10000,
    ultimate: 10000,
  } as Record<string, number>,
  concurrent: { free: 5, paid: 10 },
  source: "https://www.zoho.com/books/api/v3/introduction/#api-call-limit",
};

/** Map Zoho's plan_name (e.g. "PREMIUM TRIAL", "Standard") to a limits key. */
function planKey(planName: string): keyof typeof ZOHO_LIMITS.per_day | "unknown" {
  const p = planName.toLowerCase();
  for (const k of ["ultimate", "elite", "premium", "professional", "standard", "free"]) {
    if (p.includes(k)) return k as keyof typeof ZOHO_LIMITS.per_day;
  }
  return "unknown";
}

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const auth = await requireUser(req, { corsHeaders: CORS_HEADERS });
  if (isAuthFail(auth)) return auth.response;

  let input: { window_days?: number; company_id?: string; refresh_plan?: boolean } = {};
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
  const windowDays = Math.max(1, Math.min(90, input.window_days ?? 7));

  try {
    const supabase = getSupabase();

    // --- Plan: read from Zoho (one metered call, tagged "usage-dashboard").
    // Cached in company_config-adjacent memory would be nicer; for now one
    // call per dashboard load, which is itself visible in the log.
    let planName = "unknown";
    let orgName: string | null = null;
    let planError: string | null = null;
    try {
      const meter = createZohoMeter(supabase, {
        ...meterContextFromRequest(req, "usage-dashboard", "api-usage"),
        company_id: companyId,
      });
      const z = await getAccessToken(supabase, companyId);
      const apiBase = Deno.env.get("ZOHO_API_BASE_URL")?.trim() || "https://www.zohoapis.com/books/v3";
      const res = await meter.fetch(`${apiBase}/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
      });
      const j = await res.json();
      const orgId = z.organizationId;
      const org = ((j.organizations ?? []) as Array<Record<string, unknown>>)
        .find((o) => String(o.organization_id) === orgId) ?? (j.organizations ?? [])[0];
      if (org) {
        planName = String(org.plan_name ?? "unknown");
        orgName = org.name != null ? String(org.name) : null;
      }
    } catch (err) {
      planError = err instanceof Error ? err.message : String(err);
    }
    const key = planKey(planName);
    const perDay = key === "unknown" ? null : ZOHO_LIMITS.per_day[key];
    const concurrent = key === "free" ? ZOHO_LIMITS.concurrent.free : ZOHO_LIMITS.concurrent.paid;

    // --- Usage: today, last minute, and per-day for the window.
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();

    const { data: rows } = await supabase
      .from("zoho_api_calls")
      .select("called_at, action, function_name, endpoint, method, status, duration_ms, action_id, actor, rate_limited")
      .eq("company_id", companyId)
      .gte("called_at", windowStart)
      .order("called_at", { ascending: false })
      .limit(20000);
    const all = rows ?? [];

    const today = all.filter((r) => String(r.called_at) >= dayStart);
    const lastMinute = all.filter((r) => String(r.called_at) >= minuteAgo);

    // Per action (the "click"), today.
    const byAction: Record<string, { calls: number; clicks: Set<string>; rate_limited: number; avg_ms: number; _ms: number }> = {};
    for (const r of today) {
      const a = String(r.action);
      const e = byAction[a] ?? { calls: 0, clicks: new Set<string>(), rate_limited: 0, avg_ms: 0, _ms: 0 };
      e.calls++;
      if (r.action_id) e.clicks.add(String(r.action_id));
      if (r.rate_limited) e.rate_limited++;
      e._ms += Number(r.duration_ms ?? 0);
      byAction[a] = e;
    }
    const perAction = Object.entries(byAction).map(([action, e]) => ({
      action,
      calls_today: e.calls,
      clicks_today: e.clicks.size,
      calls_per_click: e.clicks.size ? Math.round((e.calls / e.clicks.size) * 10) / 10 : e.calls,
      rate_limited: e.rate_limited,
      avg_ms: e.calls ? Math.round(e._ms / e.calls) : 0,
    })).sort((a, b) => b.calls_today - a.calls_today);

    // Per endpoint, today.
    const byEndpoint: Record<string, number> = {};
    for (const r of today) {
      const k = `${r.method} ${r.endpoint}`;
      byEndpoint[k] = (byEndpoint[k] ?? 0) + 1;
    }
    const perEndpoint = Object.entries(byEndpoint)
      .map(([endpoint, calls]) => ({ endpoint, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 15);

    // Per day for the window.
    const byDay: Record<string, { calls: number; rate_limited: number }> = {};
    for (const r of all) {
      const d = String(r.called_at).slice(0, 10);
      const e = byDay[d] ?? { calls: 0, rate_limited: 0 };
      e.calls++;
      if (r.rate_limited) e.rate_limited++;
      byDay[d] = e;
    }
    const perDayList = Object.entries(byDay).map(([day, e]) => ({ day, ...e })).sort((a, b) => a.day.localeCompare(b.day));

    // Recent clicks (last 25 distinct action_ids) with their call counts.
    const clickMap = new Map<string, { action: string; actor: string | null; first: string; calls: number; rate_limited: number; endpoints: Set<string> }>();
    for (const r of all) {
      const id = String(r.action_id ?? "");
      if (!id) continue;
      const e = clickMap.get(id) ?? { action: String(r.action), actor: (r.actor as string | null) ?? null, first: String(r.called_at), calls: 0, rate_limited: 0, endpoints: new Set<string>() };
      e.calls++;
      if (r.rate_limited) e.rate_limited++;
      e.endpoints.add(String(r.endpoint));
      if (String(r.called_at) < e.first) e.first = String(r.called_at);
      clickMap.set(id, e);
    }
    const recentClicks = [...clickMap.entries()]
      .map(([action_id, e]) => ({ action_id, action: e.action, actor: e.actor, at: e.first, calls: e.calls, rate_limited: e.rate_limited, endpoints: e.endpoints.size }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 25);

    const rateLimitedToday = today.filter((r) => r.rate_limited).length;

    return jsonResponse({
      ok: true,
      org: { name: orgName, plan_name: planName, plan_key: key, plan_error: planError },
      limits: {
        per_minute: ZOHO_LIMITS.per_minute_all_plans,
        per_day: perDay,
        concurrent,
        source: ZOHO_LIMITS.source,
        note: "Fixed by Zoho per plan; not configurable here.",
      },
      usage: {
        calls_last_minute: lastMinute.length,
        calls_today: today.length,
        rate_limited_today: rateLimitedToday,
        pct_of_daily: perDay ? Math.round((today.length / perDay) * 1000) / 10 : null,
        pct_of_minute: Math.round((lastMinute.length / ZOHO_LIMITS.per_minute_all_plans) * 1000) / 10,
      },
      per_action_today: perAction,
      per_endpoint_today: perEndpoint,
      per_day: perDayList,
      recent_clicks: recentClicks,
      window_days: windowDays,
      generated_at: now.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("api-usage failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
