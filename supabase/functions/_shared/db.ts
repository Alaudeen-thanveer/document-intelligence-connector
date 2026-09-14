/**
 * Which database identity a function uses.
 *
 * Every function used to talk to the database with the service role, which
 * bypasses row-level security. The only thing between two clients' books was
 * each query remembering `.eq("company_id", …)`, and several did not: the
 * bank "push" selected every company's confirmed lines, the month-end hygiene
 * check returned every company's vendors and tax numbers.
 *
 * Now:
 *
 *   dataClient(auth, companyId)
 *     The default for everything a function reads or writes on a person's
 *     behalf. For a signed-in caller it carries THEIR JWT, so RLS applies to
 *     the function exactly as it does to the browser, and the approval
 *     trail records who acted. It names the verified company in
 *     `x-company-id`, which RLS honours only for a company the caller is a
 *     member of. Only for the service role — a background job with no person
 *     behind it (inbound email → ingest → extract / judgment) — is it the
 *     service-role client.
 *
 *   systemClient()
 *     The service role, for the few things that are the system's own record
 *     rather than the person's, which the browser's role deliberately cannot
 *     write: Vault token access, the tenant guard's membership lookup, the
 *     audit and ERP sync logs, the Zoho master-data cache, the API-usage log,
 *     proposal rows created by the system, and webhook receipts. Callers pass
 *     a company id they have already verified and must filter by it.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AuthOk } from "./require_user.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const NO_SESSION = { persistSession: false, autoRefreshToken: false } as const;

/** The caller's own identity: anon key + their access token. RLS applies. */
export function userClient(auth: AuthOk, companyId: string | null): SupabaseClient {
  if (auth.isServiceRole || !auth.user) {
    throw new Error("userClient needs a signed-in caller");
  }
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    auth: NO_SESSION,
    global: {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(companyId ? { "x-company-id": companyId } : {}),
      },
    },
  });
}

/** The service role. Only for the system's own records — see the header. */
export function systemClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: NO_SESSION,
  });
}

/** The caller's identity when there is a person; the service role only for background jobs. */
export function dataClient(auth: AuthOk, companyId: string | null): SupabaseClient {
  return auth.isServiceRole ? systemClient() : userClient(auth, companyId);
}

/**
 * Headers for calling a sibling function as the same caller: a person's JWT
 * is passed through, so the sibling acts as them too; only a background job
 * continues as the service role.
 */
export function siblingHeaders(auth: AuthOk, companyId: string | null): Record<string, string> {
  if (auth.isServiceRole) {
    const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    return { Authorization: `Bearer ${key}`, apikey: key };
  }
  return {
    Authorization: `Bearer ${auth.token}`,
    apikey: requireEnv("SUPABASE_ANON_KEY"),
    ...(companyId ? { "x-company-id": companyId } : {}),
  };
}
