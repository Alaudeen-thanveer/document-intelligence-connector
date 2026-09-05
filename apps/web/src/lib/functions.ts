import { functionsUrl, supabase } from "./supabase";

/**
 * Who is clicking, for the API-usage log. Set once by the app shell from
 * the reviewer-name field; every edge-function call carries it as X-Actor.
 */
let currentActor = "reviewer";
export function setActor(name: string): void {
  currentActor = name.trim() || "reviewer";
}

/**
 * Situation B: protected edge calls must carry the signed-in user's JWT.
 * Never silently fall back to the anon key (that was frontend-only "security").
 */
async function authHeaders(actionId: string): Promise<HeadersInit> {
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token?.trim();
  if (!accessToken) {
    throw new Error("Sign in required before calling edge functions");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    apikey: anon,
    "X-Action-Id": actionId,
    "X-Actor": currentActor,
  };
}

export function newActionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function callEdgeFunction(
  name:
    | "extract"
    | "judgment"
    | "zoho-push"
    | "zoho-pull"
    | "bookkeeping-learn"
    | "month-end"
    | "api-usage"
    | "bank-statement"
    | "ingest"
    | "inbound-email"
    | "vat-review"
    | "cashflow",
  body: Record<string, unknown>,
  opts?: { actionId?: string },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${functionsUrl}/${name}`, {
    method: "POST",
    headers: await authHeaders(opts?.actionId ?? newActionId()),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Kong/gateway 502s often return plain text like
    // "An invalid response was received from the upstream server"
    payload = {
      error:
        text.trim() ||
        `HTTP ${res.status} (empty response — is functions serve running?)`,
    };
  }
  return {
    ok: res.ok && payload.ok !== false,
    status: res.status,
    body: payload,
  };
}
