/**
 * Deliberate 429 retry test for withRetryOn429.
 * Run: deno run --allow-env supabase/functions/extract/retry_429_test.ts
 */
import { withRetryOn429 } from "./gemini_fallback.ts";

class Fake429Error extends Error {
  status = 429;
  constructor() {
    super("HTTP 429 Too Many Requests");
  }
}

let calls = 0;
const sleeps: number[] = [];

const { result, attempts } = await withRetryOn429(
  async () => {
    calls += 1;
    if (calls < 3) throw new Fake429Error();
    return "ok-after-retries";
  },
  {
    maxAttempts: 4,
    baseDelayMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  },
);

if (result !== "ok-after-retries") {
  console.error("FAIL: unexpected result", result);
  Deno.exit(1);
}
if (attempts !== 3) {
  console.error("FAIL: expected 3 attempts, got", attempts);
  Deno.exit(1);
}
if (calls !== 3) {
  console.error("FAIL: expected 3 calls, got", calls);
  Deno.exit(1);
}
if (JSON.stringify(sleeps) !== JSON.stringify([10, 20])) {
  console.error("FAIL: unexpected backoff delays", sleeps);
  Deno.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      test: "deliberate_429_retry",
      calls,
      attempts,
      backoff_ms: sleeps,
      result,
    },
    null,
    2,
  ),
);
