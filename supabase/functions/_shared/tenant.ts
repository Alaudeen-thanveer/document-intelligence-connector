/**
 * Which company is this caller allowed to act on?
 *
 * Edge functions run with the service role, which bypasses row-level security
 * by design. So RLS — which is airtight at the database — protects nothing
 * here, and the only thing standing between two clients is the function
 * asking who is calling. Before this module existed, most functions took
 * `company_id` from the request body, or read it off whichever document id
 * they were handed, and acted on it. A signed-in user of any client could
 * read and change another client's records.
 *
 * Every function that touches company data resolves its company through here.
 * There is deliberately no default: a fallback company is how a bug stops
 * being an error and becomes a cross-client leak.
 *
 * On refusal this answers 404, not 403. A 403 tells an attacker that the
 * company or document they named exists but is not theirs, which is a fact
 * they should not be able to learn. The refusal also never echoes back the
 * identifier they asked for.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "./cors.ts";
import type { AuthOk } from "./require_user.ts";

export type CompanyOk = { companyId: string };
export type CompanyFail = { response: Response };

export function isCompanyFail(
  r: CompanyOk | CompanyFail,
): r is CompanyFail {
  return "response" in r;
}

const DEFAULT_CORS = corsHeaders();

export type CompanyOptions = {
  /** A company the request named, if it named one. */
  companyId?: string | null;
  /** A document the request named; its company is the target. */
  documentId?: string | null;
  cors?: Record<string, string>;
  /** Shape the refusal to match the function's own error body. */
  errorBody?: (message: string) => Record<string, unknown>;
};

function refuse(
  status: number,
  message: string,
  opts?: CompanyOptions,
): CompanyFail {
  const body = opts?.errorBody ?? ((m: string) => ({ ok: false, error: m }));
  return {
    response: new Response(JSON.stringify(body(message)), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...(opts?.cors ?? DEFAULT_CORS),
      },
    }),
  };
}

/** A service-role client, for reading membership and the target document. */
function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The company this caller may act on, or a Response refusing them.
 *
 * A user may act on a company they are a member of, and on nothing else. When
 * they name neither a company nor a document and belong to exactly one
 * company, that is the one; when they belong to several, they must say which.
 *
 * The service role is the system calling itself — ingest handing off to
 * extract, inbound-email handing off to ingest — and is trusted, but it must
 * still name its target explicitly rather than falling back to a default.
 */
export async function companyForCaller(
  auth: AuthOk,
  opts: CompanyOptions = {},
): Promise<CompanyOk | CompanyFail> {
  const supabase = serviceClient();

  // What is being asked about.
  let target: string | null = opts.companyId?.trim() || null;

  if (opts.documentId) {
    const { data, error } = await supabase
      .from("documents")
      .select("company_id")
      .eq("id", opts.documentId)
      .maybeSingle();
    // A document that does not exist and one belonging to someone else look
    // the same from outside, on purpose.
    if (error || !data) return refuse(404, "Not found", opts);
    target = String(data.company_id);
  }

  if (auth.isServiceRole) {
    if (!target) {
      return refuse(400, "company_id or document_id is required", opts);
    }
    return { companyId: target };
  }

  const userId = auth.user?.id;
  if (!userId) return refuse(401, "Sign in required", opts);

  const { data: memberships, error } = await supabase
    .from("company_members")
    .select("company_id")
    .eq("user_id", userId);

  if (error) return refuse(500, "Could not read your company membership", opts);

  const mine = (memberships ?? []).map((m) => String(m.company_id));
  if (mine.length === 0) {
    return refuse(403, "This account belongs to no company", opts);
  }

  if (!target) {
    if (mine.length === 1) return { companyId: mine[0] };
    return refuse(400, "Name the company this applies to", opts);
  }

  if (!mine.includes(target)) return refuse(404, "Not found", opts);

  return { companyId: target };
}
