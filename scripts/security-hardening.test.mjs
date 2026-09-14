/**
 * The security layer, checked against the running local stack.
 *
 * Companion to tenant-isolation.test.mjs: that file asks "can one client reach
 * another?"; this one checks the specific controls that answer it — tokens
 * encrypted at rest, the email ingest path, the approval audit trail, the
 * row-level policies, and edge functions acting as the caller.
 *
 *   node --test scripts/security-hardening.test.mjs
 *
 * Needs `supabase start` and `npm run functions:serve`. Refuses to run against
 * anything but a local stack: it creates and deletes companies and users.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";

function env() {
  const file = process.env.ENV_FILE ?? new URL("../.env", import.meta.url);
  const text = readFileSync(file, "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const ENV = env();
const URL_ = ENV.SUPABASE_URL;
const ANON = ENV.SUPABASE_ANON_KEY;
const SERVICE = ENV.SUPABASE_SERVICE_ROLE_KEY;
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_ ?? "")) {
  throw new Error(`Refusing to run against ${URL_}: this suite only runs on a local stack.`);
}

const call = (key, token) => (path, init = {}) =>
  fetch(`${URL_}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
const svc = call(SERVICE, SERVICE);
const anon = call(ANON, ANON);
const asUser = (t) => call(ANON, t.token);

const PASSWORD = "hardening-Passw0rd!";
const A = { company: randomUUID(), email: `sec-a-${Date.now()}@local.test` };
const B = { company: randomUUID(), email: `sec-b-${Date.now()}@local.test` };

async function signIn(email) {
  const s = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  }).then((r) => r.json());
  assert.ok(s.access_token, `could not sign in ${email}: ${JSON.stringify(s)}`);
  return s.access_token;
}

async function makeTenant(t) {
  const cc = await svc("/rest/v1/company_config", { method: "POST", body: JSON.stringify({ company_id: t.company }) });
  assert.ok(cc.ok, `company_config: ${await cc.text()}`);
  const u = await svc("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email: t.email, password: PASSWORD, email_confirm: true }),
  }).then((r) => r.json());
  t.userId = u.id;
  assert.ok(t.userId, JSON.stringify(u));
  const m = await svc("/rest/v1/company_members", {
    method: "POST",
    body: JSON.stringify({ user_id: t.userId, company_id: t.company, role: "owner" }),
  });
  assert.equal(m.status, 201, await m.text());
  t.token = await signIn(t.email);
}

async function dropTenant(t) {
  for (const table of [
    "approval_events", "judgment_results", "extracted_fields", "erp_sync_log",
    "bank_statement_lines", "bank_statements", "audit_log", "documents",
    "zoho_access_tokens", "zoho_connections", "inbound_webhook_receipts",
    "user_company_selection", "company_members",
  ]) {
    await svc(`/rest/v1/${table}?company_id=eq.${t.company}`, { method: "DELETE" }).catch(() => {});
  }
  await svc(`/rest/v1/company_config?company_id=eq.${t.company}`, { method: "DELETE" });
  if (t.userId) await svc(`/auth/v1/admin/users/${t.userId}`, { method: "DELETE" });
}

before(async () => {
  await makeTenant(A);
  await makeTenant(B);
});

after(async () => {
  await dropTenant(A);
  await dropTenant(B);
});

// --- 1. Zoho tokens are encrypted at rest ----------------------------------
test("the Zoho access-token cache holds no plaintext token column", async () => {
  const res = await svc("/rest/v1/zoho_access_tokens?select=access_token&limit=1");
  assert.equal(res.status, 400, "zoho_access_tokens still has an access_token column");
  const ok = await svc("/rest/v1/zoho_access_tokens?select=access_token_secret_id,expires_at&limit=1");
  assert.equal(ok.status, 200, await ok.text());
});

test("the Zoho token RPCs refuse the browser's keys", async () => {
  for (const [who, fetcher] of [["anon", anon], ["a signed-in user", asUser(A)]]) {
    for (const [fn, body] of [
      ["zoho_access_token_get", { p_company_id: A.company }],
      ["zoho_access_token_put", { p_company_id: A.company, p_access_token: "x", p_expires_at: new Date().toISOString() }],
      ["zoho_refresh_token", { p_secret_id: randomUUID() }],
      ["zoho_connect", { p_company_id: A.company, p_organization_id: "1", p_refresh_token: "x" }],
    ]) {
      const res = await fetcher(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(body) });
      assert.notEqual(res.status, 200, `${who} could call ${fn}`);
      assert.notEqual(res.status, 204, `${who} could call ${fn}`);
    }
  }
});

test("a stored access token is readable only through Vault, and deleted with its connection", async () => {
  const connect = await svc("/rest/v1/rpc/zoho_connect", {
    method: "POST",
    body: JSON.stringify({ p_company_id: A.company, p_organization_id: "sec-test-org", p_refresh_token: "sec-test-refresh" }),
  });
  assert.equal(connect.status, 200, await connect.text());
  const put = await svc("/rest/v1/rpc/zoho_access_token_put", {
    method: "POST",
    body: JSON.stringify({ p_company_id: A.company, p_access_token: "sec-test-access", p_expires_at: new Date(Date.now() + 3e6).toISOString() }),
  });
  assert.ok(put.ok, await put.text());
  const got = await svc("/rest/v1/rpc/zoho_access_token_get", {
    method: "POST",
    body: JSON.stringify({ p_company_id: A.company }),
  }).then((r) => r.json());
  assert.equal(got?.[0]?.access_token, "sec-test-access");

  const rows = await svc(`/rest/v1/zoho_access_tokens?company_id=eq.${A.company}&select=*`).then((r) => r.json());
  assert.ok(!JSON.stringify(rows).includes("sec-test-access"), "the token is visible in the cache row");

  await svc(`/rest/v1/zoho_access_tokens?company_id=eq.${A.company}`, { method: "DELETE" });
  await svc(`/rest/v1/zoho_connections?company_id=eq.${A.company}`, { method: "DELETE" });
  const after = await svc("/rest/v1/rpc/zoho_access_token_get", {
    method: "POST",
    body: JSON.stringify({ p_company_id: A.company }),
  }).then((r) => r.json());
  assert.deepEqual(after, [], "the token outlived its connection");
});

// --- 2. the email ingest path, signed URLs, file safety ---------------------
/**
 * These need the functions served with a known MAILGUN_SIGNING_KEY, e.g. an
 * env file with MAILGUN_SIGNING_KEY set, passed to both `functions serve
 * --env-file` and this suite as ENV_FILE. Without one they are skipped.
 */
const SIGNING_KEY = ENV.MAILGUN_SIGNING_KEY;

function signedForm({ recipient, token = randomUUID().replace(/-/g, ""), timestamp = Math.floor(Date.now() / 1000), file }) {
  const form = new FormData();
  const ts = String(timestamp);
  form.append("timestamp", ts);
  form.append("token", token);
  form.append("signature", SIGNING_KEY ? createHmac("sha256", SIGNING_KEY).update(ts + token).digest("hex") : "0".repeat(64));
  form.append("recipient", recipient);
  form.append("sender", "vendor@example.com");
  form.append("attachment-count", "1");
  form.append("attachment-1", new Blob([file ?? "this is not a pdf"], { type: "application/pdf" }), "invoice.pdf");
  return form;
}

const postInbound = (form) =>
  fetch(`${URL_}/functions/v1/inbound-email`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${ANON}` }, body: form });

async function inboundAddress(t) {
  if (t.inbound) return t.inbound;
  const res = await svc("/rest/v1/rpc/assign_inbound_email", {
    method: "POST",
    body: JSON.stringify({ p_company_id: t.company, p_slug: `sec-${t === A ? "a" : "b"}`, p_domain: "in.security.test" }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  t.inbound = JSON.parse(text);
  return t.inbound;
}

test("inbound-email refuses an unsigned or wrongly signed webhook", async () => {
  const form = signedForm({ recipient: await inboundAddress(A) });
  form.set("signature", "0".repeat(64));
  const res = await postInbound(form);
  assert.equal(res.status, 401, await res.text());
});

test("inbound-email refuses a stale timestamp even when correctly signed", { skip: !SIGNING_KEY }, async () => {
  const res = await postInbound(signedForm({ recipient: await inboundAddress(A), timestamp: Math.floor(Date.now() / 1000) - 3600 }));
  assert.equal(res.status, 401, await res.text());
});

test("inbound-email accepts a signature token once only", { skip: !SIGNING_KEY }, async () => {
  const token = `replay${randomUUID().replace(/-/g, "")}`;
  const first = await postInbound(signedForm({ recipient: await inboundAddress(A), token }));
  // Past the signature: refused only because the attachment is not a real PDF.
  assert.equal(first.status, 400, await first.text());
  const again = await postInbound(signedForm({ recipient: await inboundAddress(A), token }));
  assert.equal(again.status, 401, `a replayed token was accepted: ${await again.text()}`);
});

test("inbound-email does not treat % or _ in the recipient as wildcards", { skip: !SIGNING_KEY }, async () => {
  const real = await inboundAddress(A);
  const wildcard = real.replace(/-[a-z0-9]+@/, "-%@");
  const res = await postInbound(signedForm({ recipient: wildcard }));
  const text = await res.text();
  // Refused at the recipient, before any company's attachments are looked at.
  assert.ok([400, 404].includes(res.status) && !/attachment/i.test(text), `a wildcard address reached a company: ${res.status} ${text}`);
});

test("inbound-email judges attachments by their bytes, not their name or type", { skip: !SIGNING_KEY }, async () => {
  const res = await postInbound(signedForm({ recipient: await inboundAddress(A), file: "MZ\x90\x00 pretending to be a pdf" }));
  assert.equal(res.status, 400, await res.text());
  const docs = await svc(`/rest/v1/documents?company_id=eq.${A.company}&source=eq.email&select=id`).then((r) => r.json());
  assert.deepEqual(docs, [], "a non-PDF attachment became a document");
});

test("ingest refuses bytes that are not a PDF or image, whatever the claimed type", async () => {
  const res = await asUser(A)("/functions/v1/ingest", {
    method: "POST",
    body: JSON.stringify({
      company_id: A.company, source: "upload", filename: "invoice.pdf", content_type: "application/pdf",
      file_base64: Buffer.from("<html><script>alert(1)</script></html>").toString("base64"), skip_judgment: true,
    }),
  });
  assert.equal(res.status, 422, await res.text());
});

test("functions refuse file references outside the caller's company folder", async () => {
  const cases = [
    ["ingest", { company_id: A.company, filename: "x.pdf", file_url: "http://169.254.169.254/latest/meta-data/" }],
    ["ingest", { company_id: A.company, filename: "x.pdf", file_url: `storage://invoices/${B.company}/secret.pdf` }],
    ["ingest", { company_id: A.company, filename: "x.pdf", file_url: `storage://invoices/${A.company}/../${B.company}/secret.pdf` }],
    ["triage", { company_id: A.company, filename: "x.pdf", sender: "a@b.c", file_url: "http://kong:8000/rest/v1/" }],
    ["bank-statement", { action: "ingest", company_id: A.company, bank_account_zoho_id: "1", source: "upload_pdf", file_url: "http://example.com/s.pdf" }],
  ];
  for (const [fn, body] of cases) {
    const res = await asUser(A)(`/functions/v1/${fn}`, { method: "POST", body: JSON.stringify(body) });
    const text = await res.text();
    assert.equal(res.status, 404, `${fn} did not refuse ${body.file_url}: ${res.status} ${text.slice(0, 200)}`);
  }
});

test("a member cannot rewrite their company's inbound address from the browser", async () => {
  const address = await inboundAddress(A);
  const res = await asUser(A)(`/rest/v1/company_config?company_id=eq.${A.company}`, {
    method: "PATCH",
    body: JSON.stringify({ inbound_email: "hijack@in.security.test" }),
  });
  assert.ok(res.status >= 400, `browser changed inbound_email (${res.status})`);
  const [row] = await svc(`/rest/v1/company_config?company_id=eq.${A.company}&select=inbound_email`).then((r) => r.json());
  assert.equal(row.inbound_email, address);
  const other = await asUser(A)(`/rest/v1/company_config?company_id=eq.${A.company}`, {
    method: "PATCH",
    body: JSON.stringify({ company_name: "Security Test A" }),
  });
  assert.ok(other.ok, `ordinary settings stopped being editable: ${await other.text()}`);
});

test("the mailbox assignment RPC refuses the browser's keys", async () => {
  for (const fetcher of [anon, asUser(A)]) {
    const res = await fetcher("/rest/v1/rpc/assign_inbound_email", {
      method: "POST",
      body: JSON.stringify({ p_company_id: B.company, p_slug: "x" }),
    });
    assert.ok(res.status >= 400, `assign_inbound_email answered ${res.status}`);
  }
});

test("the invoices bucket is private and limits size and type", async () => {
  const bucket = await svc("/storage/v1/bucket/invoices").then((r) => r.json());
  assert.equal(bucket.public, false);
  assert.ok(bucket.file_size_limit > 0 && bucket.file_size_limit <= 52428800);
  assert.deepEqual([...bucket.allowed_mime_types].sort(), ["application/pdf", "image/jpeg", "image/png", "image/webp"]);
});

// --- 3. approvals leave an append-only, attributable record ------------------
test("an override and an approval made from the browser are recorded with the verified user", async () => {
  const doc = await asUser(A)("/rest/v1/documents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ company_id: A.company, source: "upload", file_url: `storage://invoices/${A.company}/approval-probe.pdf`, status: "needs_review", doc_type: "invoice" }),
  }).then((r) => r.json());
  A.approvalDoc = doc?.[0]?.id;
  assert.ok(A.approvalDoc, JSON.stringify(doc));

  const check = await asUser(A)("/rest/v1/judgment_results", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ document_id: A.approvalDoc, rule_name: "total_matches_lines", passed: false }),
  }).then((r) => r.json());
  assert.ok(check?.[0]?.id, JSON.stringify(check));

  await asUser(A)(`/rest/v1/judgment_results?id=eq.${check[0].id}`, {
    method: "PATCH",
    body: JSON.stringify({ passed: true, reviewed_by: "Somebody Else Entirely", notes: "override: reason" }),
  });
  await asUser(A)(`/rest/v1/documents?id=eq.${A.approvalDoc}`, { method: "PATCH", body: JSON.stringify({ status: "approved" }) });

  const events = await asUser(A)(`/rest/v1/approval_events?document_id=eq.${A.approvalDoc}&order=id`).then((r) => r.json());
  const override = events.find((e) => e.action === "check_overridden");
  const approval = events.find((e) => e.action === "document_status_changed" && e.to_state === "approved");
  assert.ok(override, `no override event: ${JSON.stringify(events)}`);
  assert.ok(approval, `no approval event: ${JSON.stringify(events)}`);
  assert.equal(override.actor_user_id, A.userId, "the override is not attributed to the signed-in user");
  assert.equal(override.actor_label_self_reported, "Somebody Else Entirely");
  assert.equal(approval.actor_user_id, A.userId);

  const verify = await asUser(A)("/rest/v1/rpc/approval_events_verify", { method: "POST", body: JSON.stringify({ p_company_id: A.company }) }).then((r) => r.json());
  assert.deepEqual(verify, [], `chain reported broken: ${JSON.stringify(verify)}`);
});

test("approval events cannot be written, changed or deleted by anyone", async () => {
  const [event] = await svc(`/rest/v1/approval_events?company_id=eq.${A.company}&limit=1`).then((r) => r.json());
  assert.ok(event, "no approval event to try against");
  for (const [who, fetcher] of [["a member", asUser(A)], ["the service role", svc]]) {
    const ins = await fetcher("/rest/v1/approval_events", {
      method: "POST",
      body: JSON.stringify({ company_id: A.company, subject_table: "documents", subject_id: "x", action: "forged", actor_role: "authenticated", row_hash: "\x00" }),
    });
    assert.ok(ins.status >= 400, `${who} inserted an approval event (${ins.status})`);
    await fetcher(`/rest/v1/approval_events?id=eq.${event.id}`, { method: "PATCH", body: JSON.stringify({ to_state: "forged" }) });
    await fetcher(`/rest/v1/approval_events?id=eq.${event.id}`, { method: "DELETE" });
  }
  const [still] = await svc(`/rest/v1/approval_events?id=eq.${event.id}`).then((r) => r.json());
  assert.deepEqual(still, event, "an approval event was changed or removed");
});

test("another company sees none of the approval record, and cannot verify it", async () => {
  const events = await asUser(B)(`/rest/v1/approval_events?company_id=eq.${A.company}`).then((r) => r.json());
  assert.deepEqual(events, []);
  const res = await asUser(B)("/rest/v1/rpc/approval_events_verify", { method: "POST", body: JSON.stringify({ p_company_id: A.company }) });
  assert.notEqual(res.status, 200);
});

test("a member cannot forge audit_log rows from the browser", async () => {
  const res = await asUser(A)("/rest/v1/audit_log", {
    method: "POST",
    body: JSON.stringify({ company_id: A.company, actor_type: "human", action: "approved", detail: { forged: true } }),
  });
  assert.ok(res.status >= 400, `browser inserted into audit_log (${res.status})`);
});

// --- 4. row-level security: membership + auth.uid(), nothing for anon -------
test("a login stamped with a company it is not a member of sees none of that company", async () => {
  const email = `sec-stamp-${Date.now()}@local.test`;
  const u = await svc("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, app_metadata: { company_id: A.company } }),
  }).then((r) => r.json());
  try {
    // A bank statement and a setting in A for the stamp to reach, if it could.
    const st = await svc("/rest/v1/bank_statements", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ company_id: A.company, bank_account_zoho_id: "sec-1", source: "paste", line_count: 0 }),
    });
    assert.ok(st.ok, await st.text());
    const token = await signIn(email);
    for (const table of ["company_config", "bank_statements", "bank_statement_lines", "audit_log", "bk_history_raw", "zoho_api_calls", "documents", "approval_events"]) {
      const rows = await call(ANON, token)(`/rest/v1/${table}?select=company_id`).then((r) => r.json());
      assert.ok(Array.isArray(rows), `${table}: ${JSON.stringify(rows)}`);
      assert.equal(rows.filter((r) => r.company_id === A.company).length, 0, `${table} honoured a stamp without membership`);
    }
    const write = await call(ANON, token)(`/rest/v1/company_config?company_id=eq.${A.company}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ company_name: "stamp-only write" }),
    }).then((r) => r.json());
    assert.deepEqual(write, [], "a stamp without membership changed A's settings");
  } finally {
    await svc(`/rest/v1/bank_statements?company_id=eq.${A.company}`, { method: "DELETE" });
    await svc(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  }
});

test("anon can read, write or call nothing in the tenant schema", async () => {
  for (const table of ["documents", "company_config", "company_members", "bank_statement_lines", "zoho_entities", "zoho_connections", "approval_events", "documents_grid"]) {
    const res = await anon(`/rest/v1/${table}?select=*&limit=1`);
    const body = await res.text();
    assert.ok(res.status >= 400 || body === "[]", `anon read ${table}: ${res.status} ${body.slice(0, 120)}`);
    const ins = await anon(`/rest/v1/${table}`, { method: "POST", body: "{}" });
    assert.ok(ins.status >= 400, `anon wrote ${table}: ${ins.status}`);
  }
  for (const fn of ["current_company_id", "user_in_company", "my_companies", "set_current_company", "approval_events_verify"]) {
    const res = await anon(`/rest/v1/rpc/${fn}`, { method: "POST", body: "{}" });
    assert.ok(res.status >= 400, `anon called ${fn}: ${res.status}`);
  }
});

test("a row inserted without company_id lands in the caller's company, or nowhere", async () => {
  const vendor = `sec-vendor-${Date.now()}`;
  const mine = await asUser(A)("/rest/v1/vendor_account_rules", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ vendor_zoho_id: vendor, vendor_name: "Sec Vendor", account_zoho_id: "1", account_name: "x" }),
  });
  const text = await mine.text();
  assert.equal(mine.status, 201, text);
  assert.equal(JSON.parse(text)[0].company_id, A.company, "the default filed the row outside the caller's company");
  await svc(`/rest/v1/vendor_account_rules?vendor_zoho_id=eq.${vendor}`, { method: "DELETE" });

  const orphan = await svc("/rest/v1/documents", {
    method: "POST",
    body: JSON.stringify({ source: "upload", file_url: "x", status: "uploaded", doc_type: "invoice" }),
  });
  assert.ok(orphan.status >= 400, `a document with no company was accepted (${orphan.status})`);
});

// --- 5. edge functions act as the caller, not as the service role ----------
test("bank push, suggest and confirm cannot reach another company's lines", async () => {
  const [st] = await svc("/rest/v1/bank_statements", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ company_id: A.company, bank_account_zoho_id: "sec-bank", source: "paste", line_count: 1 }),
  }).then((r) => r.json());
  assert.ok(st?.id, "could not seed A's statement");
  const [line] = await svc("/rest/v1/bank_statement_lines", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ statement_id: st.id, company_id: A.company, line_no: 1, txn_date: "2026-08-01", description: "SEC PROBE A", side: "debit", amount: 123.45, status: "confirmed", chosen_txn_kind: "expense" }),
  }).then((r) => r.json());
  assert.ok(line?.id, "could not seed A's line");
  try {
    const push = await asUser(B)("/functions/v1/bank-statement", { method: "POST", body: JSON.stringify({ action: "push", company_id: B.company }) });
    const pushText = await push.text();
    assert.ok(!pushText.includes(line.id), `B's push returned A's line: ${pushText.slice(0, 200)}`);

    const suggest = await asUser(B)("/functions/v1/bank-statement", { method: "POST", body: JSON.stringify({ action: "suggest", company_id: B.company, statement_id: st.id }) });
    const suggestText = await suggest.text();
    assert.ok(!suggestText.includes("SEC PROBE A"), `B's suggest returned A's lines: ${suggestText.slice(0, 200)}`);

    const confirm = await asUser(B)("/functions/v1/bank-statement", {
      method: "POST",
      body: JSON.stringify({ action: "confirm", company_id: B.company, line_id: line.id, chosen_txn_kind: "expense", chosen_account_id: "attacker" }),
    });
    assert.equal(confirm.status, 404, `B confirmed A's line: ${await confirm.text()}`);

    const [after] = await svc(`/rest/v1/bank_statement_lines?id=eq.${line.id}&select=status,chosen_account_id,suggestion,error`).then((r) => r.json());
    assert.equal(after.status, "confirmed", "B's calls changed A's line status");
    assert.equal(after.chosen_account_id, null, "B's confirm changed A's line");
    assert.equal(after.error, null, "B's push touched A's line");
  } finally {
    await svc(`/rest/v1/bank_statement_lines?id=eq.${line.id}`, { method: "DELETE" });
    await svc(`/rest/v1/bank_statements?id=eq.${st.id}`, { method: "DELETE" });
  }
});

test("a function's write is attributed to the signed-in caller, not the service role", async () => {
  const [doc] = await svc("/rest/v1/documents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ company_id: A.company, source: "upload", file_url: `storage://invoices/${A.company}/attrib-probe.pdf`, status: "needs_review", doc_type: "invoice" }),
  }).then((r) => r.json());
  assert.ok(doc?.id);
  // Not connected to Zoho, so approve fails and marks the document — as the caller.
  await asUser(A)("/functions/v1/zoho-approve", { method: "POST", body: JSON.stringify({ invoice_id: doc.id }) }).then((r) => r.text());
  const events = await svc(`/rest/v1/approval_events?document_id=eq.${doc.id}&order=id`).then((r) => r.json());
  const byFunction = events.filter((e) => e.action === "document_status_changed");
  assert.ok(byFunction.length > 0, `zoho-approve left no status event: ${JSON.stringify(events)}`);
  for (const e of byFunction) {
    assert.equal(e.actor_role, "authenticated", `a function wrote as ${e.actor_role}`);
    assert.equal(e.actor_user_id, A.userId, "the function's write is not attributed to the caller");
  }
});

test("naming a company the caller is not a member of in x-company-id widens nothing", async () => {
  await svc("/rest/v1/documents", {
    method: "POST",
    body: JSON.stringify({ company_id: B.company, source: "upload", file_url: `storage://invoices/${B.company}/hdr-probe.pdf`, status: "needs_review", doc_type: "invoice" }),
  });
  const rows = await asUser(A)(`/rest/v1/documents?company_id=eq.${B.company}&select=id`, { headers: { "x-company-id": B.company } }).then((r) => r.json());
  assert.deepEqual(rows, [], "x-company-id opened another company's documents");
});
