/**
 * Situation B: human-triggered edges require a real Supabase Auth user JWT.
 * Internal sibling calls (ingest → extract/judgment, inbound-email → ingest)
 * may authenticate with the service_role key instead.
 *
 * Never treat the anon key as a signed-in user.
 */
import { createClient, type User } from "npm:@supabase/supabase-js@2";

function requireEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function jwtRole(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { role?: string };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export type AuthOk = {
  token: string;
  /** Set when Authorization is a real user access token. */
  user: User | null;
  /** True when Authorization is the service_role key / JWT. */
  isServiceRole: boolean;
};

export type AuthFail = { response: Response };

function unauthorized(
  message: string,
  cors: Record<string, string>,
  errorBody?: (message: string) => Record<string, unknown>,
): AuthFail {
  const bodyOf = errorBody ??
    ((m: string) => ({ ok: false, error: m }));
  return {
    response: new Response(JSON.stringify(bodyOf(message)), {
      status: 401,
      headers: { "Content-Type": "application/json", ...cors },
    }),
  };
}

const DEFAULT_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info, x-action-id, x-actor",
};

export type RequireAuthOptions = {
  corsHeaders?: Record<string, string>;
  errorBody?: (message: string) => Record<string, unknown>;
  /**
   * When true, accept service_role Bearer for internal machine calls.
   * Browser callers must still use a user JWT.
   */
  allowServiceRole?: boolean;
};

/**
 * Validates Authorization: Bearer <user access_token>
 * (or service_role when allowServiceRole is true).
 */
export async function requireAuth(
  req: Request,
  opts?: RequireAuthOptions,
): Promise<AuthOk | AuthFail> {
  const cors = opts?.corsHeaders ?? DEFAULT_CORS;
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return unauthorized("Sign in required", cors, opts?.errorBody);
  }

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  const role = jwtRole(token);
  const isServiceRole =
    (serviceKey.length > 0 && token === serviceKey) ||
    role === "service_role";

  if (isServiceRole) {
    if (!opts?.allowServiceRole) {
      return unauthorized("Sign in required", cors, opts?.errorBody);
    }
    return { token, user: null, isServiceRole: true };
  }

  // Anon key must not pass as a "user".
  if (role === "anon") {
    return unauthorized("Sign in required", cors, opts?.errorBody);
  }

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const anonKey = requireEnv("SUPABASE_ANON_KEY");
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) {
    return unauthorized("Sign in required", cors, opts?.errorBody);
  }

  return { token, user: data.user, isServiceRole: false };
}

/** Human-only: user JWT required (no service_role). */
export async function requireUser(
  req: Request,
  opts?: Omit<RequireAuthOptions, "allowServiceRole">,
): Promise<AuthOk | AuthFail> {
  return requireAuth(req, { ...opts, allowServiceRole: false });
}

export function isAuthFail(result: AuthOk | AuthFail): result is AuthFail {
  return "response" in result;
}
