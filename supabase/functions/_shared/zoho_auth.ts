/**
 * Which Zoho organisation a company's books live in, and a token to reach it.
 *
 * Every function used to read ZOHO_ORGANIZATION_ID and ZOHO_REFRESH_TOKEN
 * from the environment, which meant one Zoho organisation for the whole
 * deployment — fine for a single company, impossible for a practice. Each
 * company now has a row in zoho_connections naming its own organisation, and
 * its refresh token sits in Vault rather than in a column.
 *
 * The nine copies of the refresh dance that used to live in the functions are
 * one function here. They also shared one cached access token, in a table
 * whose primary key was CHECK (id = 1) — two companies would have taken turns
 * overwriting each other's token and calling Zoho as whoever wrote last.
 *
 * The OAuth *application* is still one registration (ZOHO_CLIENT_ID and
 * ZOHO_CLIENT_SECRET stay in the environment). That is how Zoho works: one
 * app, authorised separately by each organisation, yielding a refresh token
 * per organisation. It is the token and the org id that are per company.
 */
import { type SupabaseClient } from "npm:@supabase/supabase-js@2";

export type ZohoAuth = {
  accessToken: string;
  organizationId: string;
  /** e.g. https://www.zohoapis.ae/books/v3 — regional, so it travels too. */
  apiBase: string;
  accountsUrl: string;
};

export class ZohoNotConnected extends Error {
  constructor(companyId: string) {
    super(
      `This company is not connected to Zoho Books yet (company ${companyId}). ` +
        `Connect it before posting or pulling.`,
    );
    this.name = "ZohoNotConnected";
  }
}

function requireEnv(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** A minute of headroom, so a token cannot expire mid-request. */
const EXPIRY_SKEW_MS = 60_000;

type Connection = {
  organization_id: string;
  refresh_token_secret_id: string;
  accounts_url: string;
  api_base_url: string;
};

async function loadConnection(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Connection> {
  const { data, error } = await supabase
    .from("zoho_connections")
    .select("organization_id, refresh_token_secret_id, accounts_url, api_base_url")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(`Could not read the Zoho connection: ${error.message}`);
  if (!data) throw new ZohoNotConnected(companyId);
  return data as Connection;
}

/**
 * The refresh token, out of Vault. Needs the service role — an anon or user
 * key cannot read vault.decrypted_secrets, which is the point of keeping it
 * there rather than in a column beside the org id.
 */
async function refreshTokenFor(
  supabase: SupabaseClient,
  secretId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("zoho_refresh_token", {
    p_secret_id: secretId,
  });
  if (error) throw new Error(`Could not read the Zoho refresh token: ${error.message}`);
  const token = typeof data === "string" ? data.trim() : "";
  if (!token) throw new Error("The Zoho refresh token in Vault is empty");
  return token;
}

/**
 * A usable access token for this company, from cache when it is still good.
 *
 * The cache is keyed by company. Two companies refreshing at the same moment
 * write different rows, which is exactly what the old single-row table could
 * not do.
 */
export async function zohoAuthFor(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ZohoAuth> {
  const conn = await loadConnection(supabase, companyId);

  const { data: cached } = await supabase
    .from("zoho_access_tokens")
    .select("access_token, expires_at")
    .eq("company_id", companyId)
    .maybeSingle();

  if (cached?.access_token && cached.expires_at) {
    const expiresAt = Date.parse(String(cached.expires_at));
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > EXPIRY_SKEW_MS) {
      return {
        accessToken: String(cached.access_token),
        organizationId: conn.organization_id,
        apiBase: conn.api_base_url,
        accountsUrl: conn.accounts_url,
      };
    }
  }

  const refreshToken = await refreshTokenFor(supabase, conn.refresh_token_secret_id);
  const res = await fetch(`${conn.accounts_url}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: requireEnv("ZOHO_CLIENT_ID"),
      client_secret: requireEnv("ZOHO_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });

  const payload = await res.json().catch(() => ({})) as { access_token?: string };
  if (!res.ok || !payload.access_token) {
    // Never let the refresh token or the client secret into a message.
    throw new Error(`Zoho token refresh failed (${res.status})`);
  }

  const accessToken = String(payload.access_token);
  await supabase.from("zoho_access_tokens").upsert({
    company_id: companyId,
    access_token: accessToken,
    expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  });

  return {
    accessToken,
    organizationId: conn.organization_id,
    apiBase: conn.api_base_url,
    accountsUrl: conn.accounts_url,
  };
}
