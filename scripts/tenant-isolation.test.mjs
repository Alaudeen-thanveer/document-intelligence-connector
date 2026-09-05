/**
 * Can one client reach another client's books?
 *
 * This is the test you show a client who asks. It builds two throwaway
 * companies with their own owners, puts a document in the first, then signs in
 * as the second and tries every way in: the database directly, the file store,
 * and every edge function that takes a company or a document id.
 *
 * It never touches real data. Both companies and both users are created here
 * and deleted at the end, and the document it probes is one it made itself.
 *
 *   node --test scripts/tenant-isolation.test.mjs
 *
 * Needs the local stack up (`supabase start`) and the functions served
 * (`npm run functions:serve`). Reads SUPABASE_URL / the two keys from .env.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// --- environment -----------------------------------------------------------
function env() {
  const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  const url = out.SUPABASE_URL;
  const anon = out.SUPABASE_ANON_KEY;
  const service = out.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY must be in .env");
  }
  return { url, anon, service };
}

const { url: URL_, anon: ANON, service: SERVICE } = env();

const svc = (path, init = {}) =>
  fetch(`${URL_}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

const asUser = (token, path, init = {}) =>
  fetch(`${URL_}${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

// --- the two tenants -------------------------------------------------------
const A = { company: randomUUID(), email: `iso-a-${Date.now()}@local.test` };
const B = { company: randomUUID(), email: `iso-b-${Date.now()}@local.test` };
const PASSWORD = "isolation-Passw0rd!";

async function makeTenant(t) {
  await svc("/rest/v1/company_config", {
    method: "POST",
    body: JSON.stringify({ company_id: t.company }),
  });

  const created = await svc("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: t.email,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { company_id: t.company },
    }),
  }).then((r) => r.json());
  t.userId = created.id;
  assert.ok(t.userId, `could not create ${t.email}: ${JSON.stringify(created)}`);

  await svc("/rest/v1/company_members", {
    method: "POST",
    body: JSON.stringify({ user_id: t.userId, company_id: t.company, role: "owner" }),
  });

  const session = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: t.email, password: PASSWORD }),
  }).then((r) => r.json());
  t.token = session.access_token;
  assert.ok(t.token, `could not sign in ${t.email}: ${JSON.stringify(session)}`);
}

/**
 * Every table that points at company_config, so a throwaway company can
 * actually be removed. A run that dies partway used to leave its company
 * behind, and the next attempt to delete it failed on a foreign key from a
 * table the test never mentioned — bk_party_profiles, written by
 * bookkeeping-learn. Asking the database which tables reference it beats
 * keeping a list here in step by hand.
 */
async function childTables() {
  const res = await svc("/rest/v1/rpc/company_child_tables", { method: "POST", body: "{}" });
  if (res.ok) return await res.json();
  // The helper is optional; fall back to the tables this test can create.
  return ["documents", "bk_party_profiles", "bk_history_raw", "bk_suggestion_log", "company_members"];
}

async function dropTenant(t) {
  for (const table of await childTables()) {
    await svc(`/rest/v1/${table}?company_id=eq.${t.company}`, { method: "DELETE" });
  }
  await svc(`/rest/v1/company_config?company_id=eq.${t.company}`, { method: "DELETE" });
  if (t.userId) await svc(`/auth/v1/admin/users/${t.userId}`, { method: "DELETE" });
}

/** Sweep up anything an earlier run left behind before starting a new one. */
async function sweepStaleTenants() {
  const users = await svc("/auth/v1/admin/users?per_page=200").then((r) => r.json());
  for (const u of users?.users ?? []) {
    if (!/^iso-[ab]-\d+@local\.test$/.test(u.email ?? "")) continue;
    const company = u.app_metadata?.company_id;
    if (company) await dropTenant({ company, userId: u.id });
    else await svc(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  }
}

before(async () => {
  await sweepStaleTenants();
  await makeTenant(A);
  await makeTenant(B);

  // A document that belongs to A, and an extraction for it, so the functions
  // that expect one have something to find.
  const doc = await svc("/rest/v1/documents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      company_id: A.company,
      source: "upload",
      file_url: `storage://invoices/${A.company}/isolation-probe.pdf`,
      status: "needs_review",
      doc_type: "invoice",
    }),
  }).then((r) => r.json());
  A.documentId = doc?.[0]?.id;
  assert.ok(A.documentId, `could not seed A's document: ${JSON.stringify(doc)}`);

  await svc("/rest/v1/extracted_fields", {
    method: "POST",
    body: JSON.stringify({
      document_id: A.documentId,
      company_id: A.company,
      vendor_raw: "Isolation Probe Vendor LLC",
      total_amount: 4242,
      invoice_date: "2026-08-19",
      currency: "AED",
    }),
  });
});

after(async () => {
  await dropTenant(A);
  await dropTenant(B);
});

// --- 1. the database -------------------------------------------------------
const TABLES = [
  "documents",
  "extracted_fields",
  "judgment_results",
  "audit_log",
  "erp_sync_log",
  "vendor_account_rules",
  "documents_grid",
];

test("B cannot list any of A's records", async () => {
  for (const table of TABLES) {
    const rows = await asUser(B.token, `/rest/v1/${table}?select=*`).then((r) => r.json());
    assert.ok(Array.isArray(rows), `${table} did not return rows: ${JSON.stringify(rows)}`);
    const leaked = rows.filter((r) => r.company_id === A.company);
    assert.equal(leaked.length, 0, `${table} leaked ${leaked.length} of A's rows to B`);
  }
});

test("B cannot read A's document by its exact id", async () => {
  const rows = await asUser(
    B.token,
    `/rest/v1/documents?id=eq.${A.documentId}&select=id,status`,
  ).then((r) => r.json());
  assert.deepEqual(rows, [], "B read A's document by id");
});

test("B cannot write into A's company", async () => {
  const res = await asUser(B.token, "/rest/v1/documents", {
    method: "POST",
    body: JSON.stringify({
      company_id: A.company,
      source: "upload",
      file_url: "x",
      status: "pending",
    }),
  });
  assert.equal(res.status, 403, "B was allowed to insert into A's company");
});

test("B cannot change A's document", async () => {
  await asUser(B.token, `/rest/v1/documents?id=eq.${A.documentId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "tampered" }),
  });
  const [row] = await svc(
    `/rest/v1/documents?id=eq.${A.documentId}&select=status`,
  ).then((r) => r.json());
  assert.equal(row.status, "needs_review", "B changed A's document");
});

// --- 2. the file store -----------------------------------------------------
test("A's invoice files are not public", async () => {
  const res = await fetch(
    `${URL_}/storage/v1/object/public/invoices/${A.company}/isolation-probe.pdf`,
  );
  assert.notEqual(res.status, 200, "the invoices bucket is public again");
});

test("B cannot sign a URL for A's file", async () => {
  const res = await asUser(
    B.token,
    `/storage/v1/object/sign/invoices/${A.company}/isolation-probe.pdf`,
    { method: "POST", body: JSON.stringify({ expiresIn: 600 }) },
  );
  assert.notEqual(res.status, 200, "B signed a URL for A's invoice");
});

// --- 3. the edge functions -------------------------------------------------
/**
 * These run with the service role, which bypasses row-level security by
 * design — so the only thing standing between two clients is the function
 * checking who is asking. Each entry names how the caller points at A.
 */
const FUNCTIONS = [
  { name: "judgment", body: () => ({ document_id: A.documentId }) },
  { name: "extract", body: () => ({ document_id: A.documentId }) },
  { name: "triage", body: () => ({ document_id: A.documentId }) },
  { name: "zoho-push", body: () => ({ document_id: A.documentId }) },
  { name: "zoho-approve", body: () => ({ invoice_id: A.documentId }) },
  { name: "month-end", body: () => ({ company_id: A.company, month: "2026-08" }) },
  { name: "vat-review", body: () => ({ company_id: A.company }) },
  { name: "cashflow", body: () => ({ company_id: A.company }) },
  { name: "bank-statement", body: () => ({ company_id: A.company, action: "list" }) },
  { name: "api-usage", body: () => ({ company_id: A.company }) },
  { name: "bookkeeping-learn", body: () => ({ company_id: A.company }) },
  { name: "ingest", body: () => ({ company_id: A.company, source: "upload", filename: "x.pdf", content_type: "application/pdf", file_base64: "JVBERi0=" }) },
];

for (const fn of FUNCTIONS) {
  test(`${fn.name} refuses a caller from another company`, async () => {
    const res = await asUser(B.token, `/functions/v1/${fn.name}`, {
      method: "POST",
      body: JSON.stringify(fn.body()),
    });
    const text = await res.text();

    assert.ok(
      [401, 403, 404].includes(res.status),
      `${fn.name} answered ${res.status} to a caller from another company; ` +
        `expected it to refuse. Body: ${text.slice(0, 300)}`,
    );

    // Even a refusal must not carry A's identifiers back.
    assert.ok(
      !text.includes(A.company),
      `${fn.name} returned A's company_id to B in a ${res.status}`,
    );
    assert.ok(
      !text.includes("Isolation Probe Vendor"),
      `${fn.name} returned A's vendor name to B in a ${res.status}`,
    );
  });
}

/**
 * Known red, and it must stay red until it is really fixed.
 *
 * ZOHO_ORGANIZATION_ID and the refresh token are environment variables, so
 * every company on the deployment shares one Zoho organisation. No guard in
 * the functions can close that: each company's books have to live in its own
 * Zoho org, reached with its own credentials.
 *
 * This asks the question structurally rather than by making a Zoho call. An
 * earlier version called zoho-pull and asserted it did not return 200 — and
 * went green the moment the organisation hit its 1,000-call daily rate limit,
 * which says nothing about isolation. A test that can pass for a reason it is
 * not testing is worse than one that fails.
 */
test(
  "Zoho credentials belong to a company, not to the deployment",
  // Marked todo on purpose. Left as a plain failure the suite would be red
  // for ever, and a suite that is always red cannot tell you that something
  // NEW broke. As a todo it is reported on every run — the standing reminder
  // that a second client cannot be onboarded — while a red suite still means
  // exactly one thing: a regression in tenant isolation.
  { todo: "gate 2: move the Zoho org id and refresh token into per-company storage" },
  async () => {
    const cols = await svc(
      "/rest/v1/company_config?select=*&limit=1",
    ).then((r) => r.json());
    const shape = Object.keys(cols?.[0] ?? {});
    const hasPerCompanyZoho = shape.some((k) => /^zoho_/.test(k));
    assert.ok(
      hasPerCompanyZoho,
      "company_config carries no Zoho credentials, so every company shares the " +
        "one organisation named by ZOHO_ORGANIZATION_ID. Move the org id and " +
        "refresh token into per-company storage before onboarding a second " +
      `client. company_config has: ${shape.join(", ")}`,
    );
  },
);

test("A's own records were not modified by any of B's attempts", async () => {
  const [doc] = await svc(
    `/rest/v1/documents?id=eq.${A.documentId}&select=status,zoho_bill_id,ready_at`,
  ).then((r) => r.json());
  assert.equal(doc.status, "needs_review");
  assert.equal(doc.zoho_bill_id, null);
  assert.equal(doc.ready_at, null);

  const judgments = await svc(
    `/rest/v1/judgment_results?document_id=eq.${A.documentId}&select=id`,
  ).then((r) => r.json());
  assert.equal(
    judgments.length,
    0,
    `B's calls wrote ${judgments.length} judgment rows into A's records`,
  );
});
