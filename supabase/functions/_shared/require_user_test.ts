/**
 * The service role is recognised by the exact key only — never by a token
 * that merely says so.
 *
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npx deno test --no-lock --node-modules-dir=auto --allow-env --allow-net \
 *     supabase/functions/_shared/require_user_test.ts
 *
 * Needs the local stack: a token that is not the service key is checked with
 * Auth, which must refuse the forgery.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isAuthFail, requireAuth } from "./require_user.ts";

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function forged(payload: Record<string, unknown>, alg = "HS256"): string {
  return `${b64url(JSON.stringify({ alg, typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.${b64url("not-a-signature")}`;
}

function request(token: string): Request {
  return new Request("http://local/fn", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
}

Deno.test("a forged token claiming service_role is not the service role", async () => {
  for (const token of [
    forged({ role: "service_role", iss: "supabase-demo", exp: 9999999999 }),
    forged({ role: "service_role" }, "none"),
  ]) {
    const result = await requireAuth(request(token), { allowServiceRole: true });
    assert(isAuthFail(result), "a forged service_role token was accepted");
    assertEquals(result.response.status, 401);
  }
});

Deno.test("the real service role key is the service role, where allowed", async () => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const allowed = await requireAuth(request(key), { allowServiceRole: true });
  assert(!isAuthFail(allowed) && allowed.isServiceRole);
  const refused = await requireAuth(request(key), { allowServiceRole: false });
  assert(isAuthFail(refused), "the service role was accepted where only a person may call");
});

Deno.test("the anon key is not a signed-in user", async () => {
  const result = await requireAuth(request(Deno.env.get("SUPABASE_ANON_KEY")!), { allowServiceRole: true });
  assert(isAuthFail(result));
});
