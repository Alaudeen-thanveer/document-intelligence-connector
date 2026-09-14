/**
 * Is this the local development stack?
 *
 * A few safety checks have a development convenience — skipping the Mailgun
 * signature for a harness, accepting files with no malware scanner — and
 * those conveniences must never be reachable on a real deployment. They key
 * off this one answer.
 *
 * Local means SUPABASE_URL is plain http on a loopback or the CLI's internal
 * gateway host (`supabase functions serve` sets http://kong:8000). A
 * SELF-HOSTED deployment that also runs behind http://kong:8000 would match
 * too, so it must set SECURITY_ENV=production, which always wins.
 */
export function isLocalStack(): boolean {
  if ((Deno.env.get("SECURITY_ENV") ?? "").trim().toLowerCase() === "production") return false;
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  return /^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|kong|host\.docker\.internal)(:\d+)?(\/|$)/i
    .test(url);
}
