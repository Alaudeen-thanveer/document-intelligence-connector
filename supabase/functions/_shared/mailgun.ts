/**
 * Did this webhook really come from Mailgun, just now, for the first time?
 *
 * The inbound mailbox is the one endpoint with no user sign-in in front of it,
 * so this check is all that stands between the internet and a client's
 * document queue. The earlier check compared the HMAC with `===` and stopped
 * there. Now it also:
 *
 *   - compares in constant time (crypto.subtle.verify);
 *   - rejects a timestamp more than MAX_SKEW_SECONDS from now — Mailgun signs
 *     only timestamp + token, not the message, so without a window one
 *     captured signature could be replayed forever with any attachment;
 *   - remembers each token (inbound_webhook_receipts) and refuses it a second
 *     time inside that window;
 *   - honours MAILGUN_WEBHOOK_SKIP_VERIFY only on a local stack.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { isLocalStack } from "./environment.ts";

/** Mailgun's own guidance for how stale a signed webhook may be. */
export const MAX_SKEW_SECONDS = 5 * 60;

export type MailgunVerdict =
  | { ok: true; skipped: boolean }
  | { ok: false; reason: string };

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function verifyMailgunWebhook(
  supabase: SupabaseClient,
  fields: { timestamp: string; token: string; signature: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<MailgunVerdict> {
  const skip = (Deno.env.get("MAILGUN_WEBHOOK_SKIP_VERIFY") ?? "").trim().toLowerCase() === "true";
  if (skip) {
    if (isLocalStack()) return { ok: true, skipped: true };
    console.error("MAILGUN_WEBHOOK_SKIP_VERIFY is set on a non-local stack; ignoring it.");
  }

  const key = Deno.env.get("MAILGUN_SIGNING_KEY")?.trim();
  if (!key) throw new Error("MAILGUN_SIGNING_KEY is not set");

  const { timestamp, token, signature } = fields;
  const ts = Number(timestamp);
  if (!/^\d{9,11}$/.test(timestamp) || !Number.isFinite(ts)) {
    return { ok: false, reason: "bad timestamp" };
  }
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale timestamp" };
  }
  if (token.length < 16 || token.length > 256) return { ok: false, reason: "bad token" };
  const sig = hexToBytes(signature);
  if (!sig) return { ok: false, reason: "bad signature" };

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    sig as BufferSource,
    enc.encode(timestamp + token),
  );
  if (!valid) return { ok: false, reason: "signature mismatch" };

  // First time this token has been seen? The primary key answers atomically.
  const { error } = await supabase
    .from("inbound_webhook_receipts")
    .insert({ token, signed_at: new Date(ts * 1000).toISOString() });
  if (error) {
    if (error.code === "23505") return { ok: false, reason: "replayed token" };
    throw new Error("Could not record the webhook receipt");
  }
  // Tokens older than the window can never verify again; keep the table small.
  await supabase
    .from("inbound_webhook_receipts")
    .delete()
    .lt("received_at", new Date((nowSeconds - 2 * MAX_SKEW_SECONDS) * 1000).toISOString());

  return { ok: true, skipped: false };
}
