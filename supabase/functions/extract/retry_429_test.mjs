/**
 * Deliberate 429 retry test (Node) — mirrors withRetryOn429 in gemini_fallback.ts
 * Run: node supabase/functions/extract/retry_429_test.mjs
 */

function getHttpStatus(err) {
  if (!err || typeof err !== "object") return null;
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/\b(429)\b/);
  return m ? Number(m[1]) : null;
}

async function withRetryOn429(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (err) {
      lastErr = err;
      const status = getHttpStatus(err);
      if (status !== 429 || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }
  throw lastErr;
}

class Fake429Error extends Error {
  constructor() {
    super("HTTP 429 Too Many Requests");
    this.status = 429;
  }
}

let calls = 0;
const sleeps = [];

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

if (result !== "ok-after-retries" || attempts !== 3 || calls !== 3) {
  console.error("FAIL", { result, attempts, calls, sleeps });
  process.exit(1);
}
if (JSON.stringify(sleeps) !== JSON.stringify([10, 20])) {
  console.error("FAIL: unexpected backoff", sleeps);
  process.exit(1);
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
