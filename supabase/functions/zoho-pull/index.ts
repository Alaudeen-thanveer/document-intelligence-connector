// Pull Zoho Books entities (chart of accounts, vendors, customers) into the
// local zoho_entities cache so the review UI can offer posting dropdowns.
// Read-only against Zoho; replaces cached rows per kind on each sync.
// Credentials come only from environment variables — never hardcoded.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

type EntityKind = "account" | "vendor" | "customer";

interface PullInput {
  /** Which kinds to refresh; defaults to all three. */
  kinds?: EntityKind[];
}

interface EntityRow {
  kind: EntityKind;
  zoho_id: string;
  name: string;
  extra: Record<string, unknown> | null;
}

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
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function getSupabase(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function apiBase(): string {
  return (
    Deno.env.get("ZOHO_API_BASE_URL")?.trim() ||
    "https://www.zohoapis.com/books/v3"
  );
}

function orgId(): string {
  return requireEnv("ZOHO_ORGANIZATION_ID");
}

/** Exchange refresh token for a new access token (OAuth2). */
async function refreshAccessToken(): Promise<string> {
  const clientId = requireEnv("ZOHO_CLIENT_ID");
  const clientSecret = requireEnv("ZOHO_CLIENT_SECRET");
  const refreshToken = requireEnv("ZOHO_REFRESH_TOKEN");
  const accountsUrl =
    Deno.env.get("ZOHO_ACCOUNTS_URL")?.trim() || "https://accounts.zoho.com";

  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });

  const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const payload = await res.json();
  if (!res.ok || !payload?.access_token) {
    throw new Error(
      `Zoho token refresh failed (${res.status}): ${JSON.stringify(payload)}`,
    );
  }
  return String(payload.access_token);
}

async function getAccessToken(): Promise<string> {
  const existing = Deno.env.get("ZOHO_ACCESS_TOKEN")?.trim();
  if (existing) return existing;
  return await refreshAccessToken();
}

/** Fetch every page of a Zoho list endpoint (per_page=200). */
async function fetchAllPages(
  accessToken: string,
  path: string,
  listKey: string,
  extraParams = "",
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let page = 1;

  while (page <= 25) {
    const url = `${apiBase()}/${path}?organization_id=${
      encodeURIComponent(orgId())
    }&per_page=200&page=${page}${extraParams}`;
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    const raw = await res.json();
    if (!res.ok) {
      throw new Error(
        `Zoho ${path} fetch failed (${res.status}): ${JSON.stringify(raw)}`,
      );
    }
    const items =
      ((raw as Record<string, unknown>)[listKey] as Array<
        Record<string, unknown>
      >) ?? [];
    out.push(...items);

    const hasMore = Boolean(
      (raw as { page_context?: { has_more_page?: boolean } }).page_context
        ?.has_more_page,
    );
    if (!hasMore) break;
    page++;
  }
  return out;
}

async function fetchKind(
  accessToken: string,
  kind: EntityKind,
): Promise<EntityRow[]> {
  if (kind === "account") {
    const accounts = await fetchAllPages(
      accessToken,
      "chartofaccounts",
      "chartofaccounts",
    );
    return accounts
      .map((a) => ({
        kind: "account" as const,
        zoho_id: String(a.account_id ?? ""),
        name: String(a.account_name ?? ""),
        extra: {
          account_type: a.account_type ?? null,
          is_active: a.is_active ?? null,
        },
      }))
      .filter((r) => r.zoho_id && r.name);
  }

  const contacts = await fetchAllPages(
    accessToken,
    "contacts",
    "contacts",
    `&contact_type=${kind}`,
  );
  return contacts
    .map((c) => ({
      kind,
      zoho_id: String(c.contact_id ?? ""),
      name: String(c.contact_name ?? c.company_name ?? ""),
      extra: {
        company_name: c.company_name ?? null,
        status: c.status ?? null,
      },
    }))
    .filter((r) => r.zoho_id && r.name);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let input: PullInput = {};
  try {
    const text = await req.text();
    input = text ? (JSON.parse(text) as PullInput) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const kinds: EntityKind[] =
    input.kinds && input.kinds.length > 0
      ? input.kinds
      : ["account", "vendor", "customer"];

  try {
    const supabase = getSupabase();
    let accessToken = await getAccessToken();
    const counts: Record<string, number> = {};

    for (const kind of kinds) {
      let rows: EntityRow[];
      try {
        rows = await fetchKind(accessToken, kind);
      } catch (err) {
        // One retry with a fresh token on auth/transient failure.
        const msg = err instanceof Error ? err.message : String(err);
        if (/\((401|403|5\d\d)\)/.test(msg)) {
          console.log(`zoho-pull ${kind} failed (${msg}); retrying once`);
          accessToken = await refreshAccessToken();
          rows = await fetchKind(accessToken, kind);
        } else {
          throw err;
        }
      }

      // Replace the cache for this kind atomically enough for a POC.
      const { error: delError } = await supabase
        .from("zoho_entities")
        .delete()
        .eq("kind", kind);
      if (delError) {
        throw new Error(`zoho_entities delete failed: ${delError.message}`);
      }

      if (rows.length > 0) {
        const { error: insError } = await supabase
          .from("zoho_entities")
          .insert(rows);
        if (insError) {
          throw new Error(`zoho_entities insert failed: ${insError.message}`);
        }
      }
      counts[kind] = rows.length;
    }

    return jsonResponse({ ok: true, counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("zoho-pull failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
