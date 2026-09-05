/**
 * Zoho API call meter. Wraps fetch for every outbound Zoho request and logs
 * it to zoho_api_calls with the user action that caused it, so the admin
 * dashboard can show usage per click against the org's plan limits.
 *
 * Zoho sends no rate-limit headers, so this log IS the usage counter.
 * Logging is best-effort and never blocks or fails the real call.
 *
 * Usage (per edge function):
 *   const meter = createZohoMeter(supabase, { action: "sync", function_name: "zoho-pull", action_id, actor });
 *   const res = await meter.fetch(url, init);   // instead of fetch(url, init)
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface MeterContext {
  company_id?: string;
  /** The user-facing click: sync | learn | push | month-end | extract | judgment | probe */
  action: string;
  function_name: string;
  /** Correlates every call from one click. */
  action_id?: string;
  actor?: string | null;
}


/** Strip org id and numeric ids so calls group by endpoint shape. */
export function normalizeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/^\/books\/v3/, "");
    path = path.replace(/\/\d{6,}/g, "/{id}");
    return path || "/";
  } catch {
    return url;
  }
}

/** Read the click's correlation id + actor from the incoming request. */
export function meterContextFromRequest(
  req: Request,
  action: string,
  function_name: string,
): MeterContext {
  return {
    action,
    function_name,
    action_id: req.headers.get("x-action-id") ?? crypto.randomUUID(),
    actor: req.headers.get("x-actor") ?? null,
  };
}

export function createZohoMeter(supabase: SupabaseClient, ctx: MeterContext) {
  // No default company. A call that cannot say who it was for is still made
  // and still counted for the caller's own response — it just is not written
  // to another company's ledger, which is what a fallback constant did.
  const companyId = ctx.company_id ?? null;
  const actionId = ctx.action_id ?? crypto.randomUUID();
  let count = 0;
  let rateLimited = 0;

  async function log(
    method: string,
    url: string,
    status: number | null,
    startedAt: number,
  ): Promise<void> {
    count++;
    const limited = status === 429;
    if (limited) rateLimited++;
    if (!companyId) return;
    try {
      await supabase.from("zoho_api_calls").insert({
        company_id: companyId,
        action: ctx.action,
        function_name: ctx.function_name,
        method,
        endpoint: normalizeEndpoint(url),
        status,
        duration_ms: Math.round(performance.now() - startedAt),
        action_id: actionId,
        actor: ctx.actor ?? null,
        rate_limited: limited,
      });
    } catch (err) {
      // Never let metering break the real work.
      console.warn("zoho meter log failed:", err instanceof Error ? err.message : String(err));
    }
  }

  return {
    action_id: actionId,
    /** Drop-in for fetch(); logs after the response arrives. */
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const method = (init?.method ?? "GET").toUpperCase();
      const started = performance.now();
      try {
        const res = await fetch(url, init);
        // Log without awaiting the insert on the hot path.
        void log(method, url, res.status, started);
        return res;
      } catch (err) {
        void log(method, url, null, started);
        throw err;
      }
    },
    /** How many calls this click made so far (for the function's response). */
    summary(): { action_id: string; zoho_calls: number; rate_limited: number } {
      return { action_id: actionId, zoho_calls: count, rate_limited: rateLimited };
    },
  };
}
