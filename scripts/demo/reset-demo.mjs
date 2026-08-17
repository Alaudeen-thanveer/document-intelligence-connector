/**
 * Rebuild the whole demo dataset in one command.
 *
 *   node scripts/demo/reset-demo.mjs
 *
 * Steps, in order:
 *   1. seed-history.mjs    — synthetic Zoho-shaped history into bk_history_raw
 *                            (94 bills, 10 invoices, 12 journals, 58 payments)
 *                            plus the demo parties into the zoho_entities cache.
 *   2. bookkeeping-learn   — the REAL learner, reanalyze_only, over that history.
 *                            Every profile/proposal the app then shows is genuinely
 *                            computed by shipped code; only the history is invented.
 *   3. seed-documents.mjs  — six documents in the inbox, two of them awaiting a
 *                            decision, with real judgment run over them.
 *
 * Safe to re-run: each step clears its own rows first. Nothing is written to
 * Zoho Books — step 1 and 3 make no Zoho calls at all, and step 2 is told to
 * reanalyze what is already cached rather than fetch.
 *
 * NOTE: clicking "Sync from Zoho" on the Connections page replaces the cached
 * parties per kind, which removes the demo vendors. Re-run this script to
 * restore them.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ENV_PATH = process.argv[2] ? resolve(process.argv[2]) : resolve(REPO, ".env");

if (!existsSync(ENV_PATH)) {
  console.error(`Cannot find env file at ${ENV_PATH}`);
  console.error(`Pass one explicitly:  node scripts/demo/reset-demo.mjs path\\to\\.env`);
  process.exit(1);
}

const env = {};
for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) env[t.slice(0, i)] = t.slice(i + 1).trim();
}

function run(script) {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [resolve(HERE, script), ENV_PATH], { stdio: "inherit", env: process.env });
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${script} exited ${code}`))));
    child.on("error", fail);
  });
}

function step(n, what) {
  console.log(`\n[1m[${n}/3] ${what}[0m`);
}

const ok = (r) => r.ok || console.warn(`  (skipped: ${r.status})`);

// Put the demo parties back to "nothing accepted yet" so a practice run does
// not spoil the real take. Scoped to the demo names only — any rule you made
// for a real vendor is left alone.
const DEMO_PARTIES = [
  "Landlord Properties LLC", "Etisalat Business", "Falcon Freight LLC",
  "Gulf Consulting Partners", "Mixed Traders LLC", "Desert Stationery",
  "Acme Retail Group",
];
const inList = `(${DEMO_PARTIES.map((n) => `"${n}"`).join(",")})`;
const REST = { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };

step(0, "Clearing accepted demo rules so suggestions start un-decided");
for (const [table, col] of [["vendor_account_rules", "vendor_name"], ["customer_account_rules", "customer_name"]]) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${col}=in.${encodeURIComponent(inList)}`, { method: "DELETE", headers: REST });
}
await fetch(`${env.SUPABASE_URL}/rest/v1/bk_party_profiles?party_name=in.${encodeURIComponent(inList)}`, {
  method: "PATCH", headers: REST,
  body: JSON.stringify({ suggestion_status: "proposed", decided_by: null, decided_at: null }),
});
await fetch(`${env.SUPABASE_URL}/rest/v1/bk_journal_patterns?label=like.*Travel*`, {
  method: "PATCH", headers: REST,
  body: JSON.stringify({ status: "proposed" }),
});

step(1, "Seeding Zoho-shaped history and demo parties");
await run("seed-history.mjs");

// Human-triggered edges (learner, judgment) require a signed-in user since
// the auth hardening. Sign in as the local demo reviewer; credentials come
// from the env file (DEMO_USER_EMAIL / DEMO_USER_PASSWORD), never from here.
const demoEmail = env.DEMO_USER_EMAIL || process.env.DEMO_USER_EMAIL;
const demoPassword = env.DEMO_USER_PASSWORD || process.env.DEMO_USER_PASSWORD;
if (!demoEmail || !demoPassword) {
  console.error("Set DEMO_USER_EMAIL and DEMO_USER_PASSWORD in .env (a local Auth user who is a company member) — see docs/SECURITY_BASELINE.md.");
  process.exit(1);
}
const signIn = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: demoEmail, password: demoPassword }),
});
const session = await signIn.json();
if (!signIn.ok || !session.access_token) {
  console.error("Could not sign in as the demo reviewer:", JSON.stringify(session).slice(0, 300));
  process.exit(1);
}
process.env.DEMO_USER_JWT = session.access_token; // children use it for judgment
console.log(`    signed in as ${demoEmail}`);

step(2, "Running the real learner over that history (no Zoho calls)");
const learn = await fetch(`${env.SUPABASE_URL}/functions/v1/bookkeeping-learn`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${session.access_token}`,
    apikey: env.SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
    "X-Actor": "demo-reset",
  },
  body: JSON.stringify({ reanalyze_only: true, months_back: 24 }),
});
const learned = await learn.json();
if (!learn.ok || learned.ok === false) {
  console.error("learner failed:", JSON.stringify(learned).slice(0, 400));
  console.error("Is the stack up?  npx supabase status");
  process.exit(1);
}
console.log(
  `    analyzed=${learned.documents_analyzed} · profiles=${learned.profiles_written} ` +
    `(${learned.proposable} proposable) · rhythms=${learned.rhythms_written} ` +
    `· checks=${learned.checks_proposed} · attachment conventions=${learned.attachment_conventions_written}\n` +
    `    timing=${learned.timing_profiles_written} · later-than-usual=${learned.later_than_usual_proposed} ` +
    `· journal patterns=${learned.journal_patterns_written} · Zoho calls=${learned.usage?.zoho_calls ?? 0}`,
);

step(3, "Seeding the document inbox and running real judgment");
await run("seed-documents.mjs");

console.log(`
[1mDemo is ready.[0m  Open http://localhost:5173

  Rules        5 account suggestions (none accepted yet), 15 checks across
               4 vendors, 1 repeating manual journal. Mixed Traders LLC is the
               deliberate "won't guess" split-party case.
  Documents    6 rows. dd000001 NEEDS_REVIEW (Etisalat, no attachment) and
               dd000002 JUDGMENT_PASSED (Al Noor, vendor not in Zoho).
  Month-end    2 items need attention — 3 once you enable the journal pattern.

  Do NOT click "Sync from Zoho" on Connections during a demo — it replaces the
  cached parties with the real org's data. Re-run this script to restore.
`);
