/**
 * Which website may call these functions from a browser.
 *
 * Every function used to answer "*": any site on the internet could make a
 * signed-in person's browser call us. Not an open door on its own — a
 * stranger's site holds no login token — but it is the development default,
 * and not one to carry into a practice's live books.
 *
 * ALLOWED_ORIGIN names the app's own address, one origin, no trailing slash
 * (https://app.example.com). When it is set, only that origin is answered.
 * When it is not set:
 *
 *   - against a local stack (SUPABASE_URL on localhost / 127.0.0.1) the
 *     answer is "*", so `npm run web:dev` works with nothing configured;
 *   - anywhere else, no origin is answered at all. A hosted deployment with
 *     the setting missing fails closed, and the browser console says why.
 *
 * Two things worth knowing. The local gateway (Kong) adds "*" to every
 * response and answers preflight itself before a function runs, so locally
 * this cannot be seen to tighten anything; hosted, the gateway adds nothing
 * and the function's header is the only one there is. And a static header
 * can name one origin: an app with several addresses (preview and
 * production, say) would need the request's Origin echoed back against a
 * list, which is a small change here and nowhere else.
 */

/** The headers the browser is allowed to send us. */
export const DEFAULT_ALLOW_HEADERS =
  "authorization, content-type, apikey, x-client-info, x-action-id, x-actor";

function resolveOrigin(): string | null {
  const configured = Deno.env.get("ALLOWED_ORIGIN")?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i
    .test(url);
  if (local) return "*";

  console.warn(
    "ALLOWED_ORIGIN is not set and SUPABASE_URL is not a local stack: " +
      "no browser origin will be allowed. Set ALLOWED_ORIGIN to the app's address.",
  );
  return null;
}

/** Decided once per isolate; the environment does not change underneath us. */
const ORIGIN = resolveOrigin();

/**
 * CORS headers for a response. Empty when no origin is allowed — the
 * browser then refuses to hand the response to the page, which is the
 * intended outcome of a hosted deployment that never named its app.
 */
export function corsHeaders(
  allowHeaders: string = DEFAULT_ALLOW_HEADERS,
): Record<string, string> {
  if (ORIGIN === null) return {};
  return {
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Headers": allowHeaders,
    // A named origin means the answer depends on who asked; caches must
    // not hand one site's answer to another.
    ...(ORIGIN === "*" ? {} : { Vary: "Origin" }),
  };
}
