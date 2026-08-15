import { functionsUrl } from "./supabase";

function authHeaders(): HeadersInit {
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${anon}`,
    apikey: anon,
  };
}

export async function callEdgeFunction(
  name:
    | "extract"
    | "judgment"
    | "zoho-push"
    | "zoho-pull"
    | "bookkeeping-learn"
    | "month-end",
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${functionsUrl}/${name}`, {
    method: "POST",
    headers: authHeaders(),
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
