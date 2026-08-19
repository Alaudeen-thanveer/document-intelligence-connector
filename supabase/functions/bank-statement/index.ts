// Bank statements: ingest → suggest per line → confirm → push.
//
// Actions (POST { action, ... }):
//   ingest   { bank_account_zoho_id, source, text? | file_url?, original_name?,
//              month_first?, currency? }
//            Parse a statement (CSV/TSV/pasted text directly; PDF through the
//            vision model) into dated debit/credit lines, store them, then
//            compute a suggestion for every line. Lines with nothing
//            suggestible simply stay open. Returns statement + lines.
//   suggest  { statement_id }      Recompute suggestions for open lines.
//   confirm  { line_id, chosen_* } Record what the reviewer decided. Nothing
//                                  goes to Zoho here.
//   push     { statement_id | line_ids } Post confirmed lines to Zoho Books.
//   party_credits { party_kind, party_zoho_id } Unused credit a party holds.
//   pull_feed { bank_account_zoho_id, date_start? }
//            FEED MODE: pull Zoho's own uncategorised transactions for a
//            bank account into a statement (source zoho_feed), suggest per
//            line (Zoho's match candidates first), and on push act with
//            Zoho's verbs — match / categorize / exclude — so Zoho keeps the
//            statement and the reconciliation.
//
// The email path calls `ingest` with source 'email' and the body/attachment
// text — same code, different tag.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "npm:@google/generative-ai@0.24.1";
import { createZohoMeter, meterContextFromRequest } from "../_shared/zoho_meter.ts";
import { isAuthFail, requireAuth } from "../_shared/require_user.ts";
import { normalizeModelRows, type ParsedLine, type ParseResult, parseStatementText } from "./parse.ts";
import {
  DEFAULT_POLICIES, fetchOpenCredits, fetchOpenDocuments, suggestForLines,
  type LineForSuggest, type OpenCredit, type OpenDoc, type PartyRef, type Policies, type RecordedPost, type Suggestion,
} from "./suggest.ts";
import { type BankPattern } from "../bookkeeping-learn/bank_patterns.ts";
import { pushLine } from "./push.ts";
import { buildFeedRequest, extractZohoId, suggestFromZohoMatches, uncategorizedToLines, type ZohoMatchCandidate, type ZohoUncategorizedRow } from "./feed.ts";
import { isProposableAsZohoRule, zohoRuleBodyForPattern, type ZohoBankRule } from "./zoho_rules.ts";
import { attachTargetFor, buildLineEvidence, textToPdf } from "./evidence.ts";

const DEFAULT_COMPANY = "00000000-0000-4000-8000-000000000001";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-action-id, x-actor",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function requireEnv(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
function getSupabase(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
function apiBase(): string {
  return Deno.env.get("ZOHO_API_BASE_URL")?.trim() || "https://www.zohoapis.com/books/v3";
}

// --------------------------------------------------------------- Zoho auth
async function getAccessToken(supabase: SupabaseClient): Promise<string> {
  const existing = Deno.env.get("ZOHO_ACCESS_TOKEN")?.trim();
  if (existing) return existing;
  const { data } = await supabase.from("zoho_oauth_tokens").select("access_token, expires_at").eq("id", 1).maybeSingle();
  if (data?.access_token && new Date(String(data.expires_at)).getTime() > Date.now() + 120_000) return String(data.access_token);
  const accountsUrl = Deno.env.get("ZOHO_ACCOUNTS_URL")?.trim() || "https://accounts.zoho.com";
  const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: requireEnv("ZOHO_REFRESH_TOKEN"), client_id: requireEnv("ZOHO_CLIENT_ID"),
      client_secret: requireEnv("ZOHO_CLIENT_SECRET"), grant_type: "refresh_token",
    }),
  });
  const payload = await res.json();
  if (!res.ok || !payload?.access_token) throw new Error(`Zoho token refresh failed (${res.status}): ${JSON.stringify(payload)}`);
  const token = String(payload.access_token);
  await supabase.from("zoho_oauth_tokens").upsert({
    id: 1, access_token: token, expires_at: new Date(Date.now() + 55 * 60_000).toISOString(), updated_at: new Date().toISOString(),
  });
  return token;
}

// ------------------------------------------------------------ PDF → rows
/**
 * Read a statement PDF/image with the vision model and return loose rows;
 * normalisation happens in parse.ts so PDF and CSV come out identical.
 */
async function rowsFromFile(fileUrl: string): Promise<{ rows: Array<Record<string, unknown>>; meta: Record<string, unknown> }> {
  const apiKey = requireEnv("GEMINI_API_KEY");
  const modelName = Deno.env.get("GEMINI_MODEL")?.trim() || "gemini-3.6-flash";
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Could not fetch statement file (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "application/pdf";

  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });
  const prompt = [
    "This is a bank statement. Extract EVERY transaction row into JSON.",
    'Shape: {"account_hint": string|null, "currency": string|null, "period_start": "YYYY-MM-DD"|null, "period_end": "YYYY-MM-DD"|null,',
    ' "rows": [{"date": string, "value_date": string|null, "description": string, "reference": string|null,',
    '           "debit": string|null, "credit": string|null, "amount": string|null, "balance": string|null}]}',
    "Copy dates and amounts exactly as printed (do not reformat). Put money OUT in debit and money IN in credit;",
    "if the statement has one signed amount column, put it in amount with its sign. Skip opening/closing balance and total rows.",
    "Keep the description text verbatim including reference codes. JSON only, no markdown.",
  ].join(" ");
  const out = await model.generateContent([{ text: prompt }, { inlineData: { mimeType, data: btoa(binary) } }]);
  const text = out.response.text().trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    parsed = JSON.parse(text.slice(s, e + 1));
  }
  const rows = (parsed.rows as Array<Record<string, unknown>>) ?? [];
  const { rows: _r, ...meta } = parsed;
  return { rows, meta };
}

// ------------------------------------------------------------- helpers
async function loadPatterns(supabase: SupabaseClient, companyId: string): Promise<BankPattern[]> {
  const { data } = await supabase.from("bk_bank_patterns").select("*").eq("company_id", companyId).neq("suggestion_status", "dismissed");
  return (data ?? []).map((r) => ({
    fingerprint: String(r.fingerprint), tokens: (r.tokens as string[]) ?? [], side: r.side, txn_kind: r.txn_kind,
    party_kind: r.party_kind ?? null, party_zoho_id: r.party_zoho_id ?? null, party_name: r.party_name ?? null,
    account_id: r.account_id ?? null, account_name: r.account_name ?? null,
    sample_size: Number(r.sample_size), share: Number(r.share), amount_median: Number(r.amount_median ?? 0),
    amount_p10: Number(r.amount_p10 ?? 0), amount_p90: Number(r.amount_p90 ?? 0),
    first_seen: String(r.first_seen ?? ""), last_seen: String(r.last_seen ?? ""),
    examples: (r.examples as string[]) ?? [], confidence: Number(r.confidence),
    // carried for the suggestion's "source" label
    ...({ suggestion_status: r.suggestion_status } as Record<string, unknown>),
  })) as BankPattern[];
}

async function loadParties(supabase: SupabaseClient): Promise<PartyRef[]> {
  const { data } = await supabase.from("zoho_entities").select("kind, zoho_id, name").in("kind", ["vendor", "customer"]);
  return (data ?? []).map((r) => ({ kind: r.kind as "vendor" | "customer", zoho_id: String(r.zoho_id), name: String(r.name) }));
}

async function loadPolicies(supabase: SupabaseClient, companyId: string): Promise<Policies> {
  const { data } = await supabase.from("company_config")
    .select("already_recorded_window_days, bank_charge_tolerance, writeoff_after_days, writeoff_max_amount")
    .eq("company_id", companyId).maybeSingle();
  if (!data) return DEFAULT_POLICIES;
  return {
    already_recorded_window_days: Number(data.already_recorded_window_days ?? 3),
    bank_charge_tolerance: (data.bank_charge_tolerance as Record<string, number>) ?? DEFAULT_POLICIES.bank_charge_tolerance,
    writeoff_after_days: data.writeoff_after_days != null ? Number(data.writeoff_after_days) : null,
    writeoff_max_amount: data.writeoff_max_amount != null ? Number(data.writeoff_max_amount) : null,
  };
}

/**
 * Everything THIS APP has already posted that could show up on a
 * statement: posted bank lines (any statement but this one) and documents
 * pushed to Zoho as expenses (paid through a bank account). Bills and
 * invoices are not payments and are not included. Zoho itself is not
 * queried here — by the reviewer's decision.
 */
async function loadRecorded(supabase: SupabaseClient, companyId: string, statementId: string): Promise<RecordedPost[]> {
  const out: RecordedPost[] = [];
  const { data: lines } = await supabase.from("bank_statement_lines")
    .select("statement_id, line_no, txn_date, description, side, amount, chosen_txn_kind, chosen_party_kind, chosen_party_zoho_id, chosen_party_name, zoho_txn_id, chosen_ref_kind, chosen_ref_zoho_id, bank_statements!inner(bank_account_name, period_start)")
    .eq("company_id", companyId).eq("status", "posted").neq("statement_id", statementId);
  for (const l of lines ?? []) {
    const k = String(l.chosen_txn_kind ?? "");
    if (!["customer_payment", "vendor_payment", "expense", "retainer_receipt", "already_recorded"].includes(k)) continue;
    const st = (l as { bank_statements: { bank_account_name: string | null; period_start: string | null } }).bank_statements;
    out.push({
      kind: k === "customer_payment" || k === "retainer_receipt" ? "customer_payment" : k === "vendor_payment" ? "vendor_payment" : k === "expense" ? "expense" : "other",
      zoho_id: String(l.zoho_txn_id ?? l.chosen_ref_zoho_id ?? ""),
      ref_kind: (k === "customer_payment" || k === "retainer_receipt") ? "customerpayment" : k === "vendor_payment" ? "vendorpayment" : k === "expense" ? "expense" : "banktransaction",
      party_kind: (l.chosen_party_kind as "vendor" | "customer" | null) ?? null,
      party_zoho_id: l.chosen_party_zoho_id ? String(l.chosen_party_zoho_id) : null,
      party_name: l.chosen_party_name ? String(l.chosen_party_name) : null,
      amount: Number(l.amount), date: String(l.txn_date), side: l.side as "debit" | "credit",
      description: String(l.description ?? ""),
      source: `statement line ${l.line_no} (${st?.bank_account_name ?? "bank"} ${st?.period_start ?? ""})`,
    });
  }
  // Documents pushed as expenses.
  const { data: syncs } = await supabase.from("erp_sync_log").select("document_id, external_doc_id, synced_at").eq("external_kind", "expenses");
  if (syncs?.length) {
    const ids = syncs.map((x) => String(x.document_id));
    const { data: fields } = await supabase.from("extracted_fields").select("document_id, vendor_raw, total_amount, invoice_date").in("document_id", ids);
    const byDoc = new Map((fields ?? []).map((f) => [String(f.document_id), f]));
    for (const x of syncs) {
      const f = byDoc.get(String(x.document_id));
      if (!f || f.total_amount == null) continue;
      out.push({
        kind: "expense", zoho_id: String(x.external_doc_id), ref_kind: "expense",
        party_kind: "vendor", party_zoho_id: null, party_name: f.vendor_raw ? String(f.vendor_raw) : null,
        amount: Number(f.total_amount), date: String(f.invoice_date ?? String(x.synced_at).slice(0, 10)).slice(0, 10), side: "debit",
        description: f.vendor_raw ? String(f.vendor_raw) : null, source: `expense from document ${String(x.document_id).slice(0, 8)}`,
      });
    }
  }
  // Vendor payments recorded from the payment run (cashflow) — audited with
  // vendor/amount/date/zoho id, so the eventual statement line links to them.
  const { data: runs } = await supabase.from("audit_log").select("detail, created_at").eq("company_id", companyId).eq("action", "vendor_payment_recorded");
  for (const r of runs ?? []) {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    if (!d.zoho_payment_id) continue;
    out.push({
      kind: "vendor_payment", zoho_id: String(d.zoho_payment_id), ref_kind: "vendorpayment",
      party_kind: "vendor", party_zoho_id: d.vendor_zoho_id ? String(d.vendor_zoho_id) : null, party_name: d.vendor_name ? String(d.vendor_name) : null,
      amount: Number(d.amount ?? 0) || 0, date: String(d.date ?? String(r.created_at).slice(0, 10)), side: "debit",
      description: d.vendor_name ? String(d.vendor_name) : null, source: `payment run (${String(d.date ?? "")})`,
    });
  }
  return out.filter((r) => r.zoho_id);
}

/**
 * Attach the statement evidence to a record just created from a line: the
 * uploaded statement file when one exists, else a text note carrying the
 * line and its context. Best effort — never undoes the record.
 */
async function attachStatementEvidence(
  supabase: SupabaseClient,
  zohoFetch: typeof fetch,
  token: string,
  line: { line_no: number; txn_date: string; description: string; reference: string | null; side: "debit" | "credit"; amount: number },
  stmt: { bank_account_name: string | null; bank_account_zoho_id: string; period_start: string | null; period_end: string | null; source: string; original_name: string | null; currency: string | null; file_url: string | null },
  kind: string,
  zohoId: string,
  actor: string,
): Promise<{ attached: boolean; filename?: string; error?: string }> {
  const target = attachTargetFor(kind, zohoId);
  if (!target) return { attached: false, error: "no attachment slot for this record kind" };
  const upload = async (bytes: Uint8Array, contentType: string, filename: string) => {
    const form = new FormData();
    form.append(target.field, new Blob([bytes as BlobPart], { type: contentType }), filename);
    const res = await zohoFetch(`${apiBase()}/${target.path}?organization_id=${encodeURIComponent(requireEnv("ZOHO_ORGANIZATION_ID"))}`, {
      method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}` }, body: form,
    });
    const raw = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: res.ok && (raw.code == null || raw.code === 0), message: String(raw.message ?? res.status) };
  };
  const pdfNote = () => {
    const ev = buildLineEvidence(line, stmt, actor);
    return { bytes: textToPdf(ev.text), filename: ev.filename };
  };
  try {
    // The statement file itself when there is one; ANY failure on that path
    // (missing object, refused extension) falls back to the PDF note — the
    // evidence must not vanish because the file could not travel.
    if (stmt.file_url && stmt.file_url.startsWith("storage://invoices/")) {
      try {
        const path = stmt.file_url.slice("storage://invoices/".length);
        const { data, error } = await supabase.storage.from("invoices").download(path);
        if (error || !data) throw new Error(`storage download failed: ${error?.message ?? "no data"}`);
        const filename = stmt.original_name ?? path.split("/").pop() ?? "statement";
        const first = await upload(new Uint8Array(await data.arrayBuffer()), data.type || "application/octet-stream", filename);
        if (first.ok) return { attached: true, filename };
        console.warn(`statement file not attachable (${first.message}) — PDF note instead`);
      } catch (err) {
        console.warn(`statement file unavailable (${err instanceof Error ? err.message : String(err)}) — PDF note instead`);
      }
    }
    const note = pdfNote();
    const second = await upload(note.bytes, "application/pdf", note.filename);
    return second.ok ? { attached: true, filename: note.filename } : { attached: false, filename: note.filename, error: second.message };
  } catch (err) {
    return { attached: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function computeAndStoreSuggestions(
  supabase: SupabaseClient, zohoFetch: typeof fetch, companyId: string, statementId: string,
): Promise<{ suggested: number; open: number; open_docs: number; zoho_matched?: number }> {
  const { data: lines } = await supabase.from("bank_statement_lines")
    .select("id, line_no, txn_date, description, reference, side, amount").eq("statement_id", statementId).eq("status", "open").order("line_no");
  const list = (lines ?? []) as Array<LineForSuggest & { id: string }>;
  if (!list.length) return { suggested: 0, open: 0, open_docs: 0 };

  const [patterns, parties, policies, recorded, stmt] = await Promise.all([
    loadPatterns(supabase, companyId), loadParties(supabase), loadPolicies(supabase, companyId),
    loadRecorded(supabase, companyId, statementId), supabase.from("bank_statements").select("currency, bank_account_zoho_id").eq("id", statementId).maybeSingle(),
  ]);
  let currency = (stmt.data?.currency as string | null) ?? null;
  if (!currency && stmt.data?.bank_account_zoho_id) {
    const { data: acct } = await supabase.from("zoho_entities").select("extra").eq("kind", "bank_account").eq("zoho_id", String(stmt.data.bank_account_zoho_id)).maybeSingle();
    currency = ((acct?.extra as Record<string, unknown> | null)?.currency_code as string | undefined) ?? null;
  }
  currency = currency ?? "AED";
  let openDocs: OpenDoc[] = [];
  let openCredits: OpenCredit[] = [];
  try {
    const token = await getAccessToken(supabase);
    const org = requireEnv("ZOHO_ORGANIZATION_ID");
    [openDocs, openCredits] = await Promise.all([
      fetchOpenDocuments(zohoFetch, apiBase(), org, token),
      fetchOpenCredits(zohoFetch, apiBase(), org, token),
    ]);
  } catch (err) {
    console.warn("open documents unavailable; suggesting from patterns only:", err instanceof Error ? err.message : err);
  }
  // The org's own bank rules (synced as zoho_entities kind bank_rule) and feed payees.
  const { data: ruleRows } = await supabase.from("zoho_entities").select("zoho_id, name, extra").eq("kind", "bank_rule");
  const zohoRules: ZohoBankRule[] = (ruleRows ?? []).map((r) => {
    const extra = (r.extra as Record<string, unknown>) ?? {};
    return { ...extra, rule_id: String(r.zoho_id), rule_name: String(r.name), criterion: (extra.criterion as ZohoBankRule["criterion"]) ?? [] } as ZohoBankRule;
  });
  const { data: payeeRows } = await supabase.from("bank_statement_lines").select("line_no, zoho_payee").eq("statement_id", statementId).not("zoho_payee", "is", null);
  const payees: Record<number, string | null> = Object.fromEntries((payeeRows ?? []).map((r) => [Number(r.line_no), (r.zoho_payee as string | null) ?? null]));
  const suggestions = suggestForLines(list, { patterns, parties, openDocs, openCredits, recorded, policies, currency, today: new Date().toISOString().slice(0, 10), zohoRules, bankAccountId: stmt.data?.bank_account_zoho_id ? String(stmt.data.bank_account_zoho_id) : null, payees });

  // Feed mode: ask Zoho for its own match candidates per line — a record
  // already in the books that this line should be LINKED to, not recreated.
  // That is the duplicate control when the statement lives in Zoho, so it
  // outranks everything except our own already-recorded link.
  const { data: feedRows } = await supabase.from("bank_statement_lines").select("id, zoho_uncategorized_id")
    .eq("statement_id", statementId).not("zoho_uncategorized_id", "is", null);
  const feedIds = new Map((feedRows ?? []).map((r) => [String(r.id), String(r.zoho_uncategorized_id)]));
  let zohoMatched = 0;
  if (feedIds.size) {
    let token: string | null = null;
    try { token = await getAccessToken(supabase); } catch { token = null; }
    const org = Deno.env.get("ZOHO_ORGANIZATION_ID")?.trim() ?? "";
    for (let i = 0; i < list.length && token; i++) {
      const uncatId = feedIds.get(String(list[i].id));
      if (!uncatId) continue;
      try {
        const res = await zohoFetch(`${apiBase()}/banktransactions/uncategorized/${encodeURIComponent(uncatId)}/match?organization_id=${encodeURIComponent(org)}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
        const j = await res.json().catch(() => ({}));
        const cands = ((j as { matching_transactions?: ZohoMatchCandidate[] }).matching_transactions ?? []).slice(0, 10);
        await supabase.from("bank_statement_lines").update({ zoho_match_candidates: cands }).eq("id", list[i].id);
        if (cands.length && suggestions[i]?.source !== "already_recorded") {
          const m = suggestFromZohoMatches(list[i], cands, policies.already_recorded_window_days);
          if (m) { suggestions[i] = m; zohoMatched++; }
        }
      } catch (err) {
        console.warn("zoho match lookup failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  let suggested = 0;
  for (let i = 0; i < list.length; i++) {
    const s: Suggestion | null = suggestions[i];
    await supabase.from("bank_statement_lines").update({ suggestion: s }).eq("id", list[i].id);
    if (s) suggested++;
  }
  return { suggested, open: list.length - suggested, open_docs: openDocs.length, zoho_matched: zohoMatched };
}

// ------------------------------------------------------------------ main
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let input: Record<string, unknown> = {};
  try {
    const t = await req.text();
    input = t ? JSON.parse(t) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const action = String(input.action ?? "");

  // Same posture as every human-triggered edge: a signed-in user's JWT.
  // The one exception is `ingest`, which the mailbox pipeline calls
  // machine-to-machine with the service role (source 'email'); browser
  // callers of ingest still need a user session. Everything that decides
  // or posts (confirm / push) is human-only.
  const auth = await requireAuth(req, {
    corsHeaders: CORS_HEADERS,
    allowServiceRole: action === "ingest",
  });
  if (isAuthFail(auth)) return auth.response;
  if (auth.isServiceRole && String(input.source ?? "") !== "email") {
    return jsonResponse({ ok: false, error: "Sign in required" }, 401);
  }

  const companyId = String(input.company_id ?? DEFAULT_COMPANY);
  const actor = auth.user?.email?.split("@")[0]
    ?? (req.headers.get("x-actor")?.trim() || (auth.isServiceRole ? "mailbox" : "reviewer"));
  const supabase = getSupabase();
  const meter = createZohoMeter(supabase, { ...meterContextFromRequest(req, `bank-${action || "unknown"}`, "bank-statement"), company_id: companyId });

  try {
    // ------------------------------------------------------------ ingest
    if (action === "ingest") {
      const bankAccountId = String(input.bank_account_zoho_id ?? "").trim();
      if (!bankAccountId) return jsonResponse({ ok: false, error: "bank_account_zoho_id is required — pick which bank account this statement belongs to" }, 400);
      const source = String(input.source ?? "paste");
      if (!["upload_csv", "upload_pdf", "paste", "email"].includes(source)) return jsonResponse({ ok: false, error: "source must be upload_csv | upload_pdf | paste | email" }, 400);
      const monthFirst = Boolean(input.month_first);

      let parsed: ParseResult;
      let meta: Record<string, unknown> = {};
      if (input.text && String(input.text).trim()) {
        parsed = parseStatementText(String(input.text), { monthFirst });
      } else if (input.file_url) {
        const r = await rowsFromFile(String(input.file_url));
        parsed = normalizeModelRows(r.rows, { monthFirst });
        meta = r.meta;
      } else {
        return jsonResponse({ ok: false, error: "Provide text (CSV/TSV/pasted) or file_url (PDF/image)" }, 400);
      }
      if (!parsed.lines.length) {
        return jsonResponse({ ok: false, error: "No transaction rows found", skipped: parsed.skipped, parse: { delimiter: parsed.delimiter, columns: parsed.columns } }, 422);
      }

      const { data: acct } = await supabase.from("zoho_entities").select("name").eq("kind", "bank_account").eq("zoho_id", bankAccountId).maybeSingle();
      const dates = parsed.lines.map((l) => l.txn_date).sort();
      const { data: st, error: stErr } = await supabase.from("bank_statements").insert({
        company_id: companyId, bank_account_zoho_id: bankAccountId,
        bank_account_name: acct?.name ?? (input.bank_account_name ?? null),
        source, file_url: input.file_url ?? null, original_name: input.original_name ?? null,
        currency: input.currency ?? meta.currency ?? null,
        period_start: dates[0], period_end: dates[dates.length - 1],
        line_count: parsed.lines.length, skipped_rows: parsed.skipped,
        parse_info: { delimiter: parsed.delimiter, columns: parsed.columns, ...meta },
        created_by: actor,
      }).select("id").single();
      if (stErr || !st) throw new Error(`could not save statement: ${stErr?.message}`);

      const rows = parsed.lines.map((l: ParsedLine) => ({
        statement_id: st.id, company_id: companyId, line_no: l.line_no, txn_date: l.txn_date, value_date: l.value_date,
        description: l.description, reference: l.reference, side: l.side, amount: l.amount, balance: l.balance,
      }));
      const { error: lErr } = await supabase.from("bank_statement_lines").insert(rows);
      if (lErr) throw new Error(`could not save lines: ${lErr.message}`);

      const sug = await computeAndStoreSuggestions(supabase, meter.fetch, companyId, st.id);
      const { data: outLines } = await supabase.from("bank_statement_lines").select("*").eq("statement_id", st.id).order("line_no");
      return jsonResponse({
        ok: true, statement_id: st.id, lines: outLines ?? [], line_count: parsed.lines.length,
        skipped: parsed.skipped, parse: { delimiter: parsed.delimiter, columns: parsed.columns },
        suggestions: sug, usage: meter.summary(),
      });
    }

    // ----------------------------------------------------------- suggest
    if (action === "suggest") {
      const statementId = String(input.statement_id ?? "");
      if (!statementId) return jsonResponse({ ok: false, error: "statement_id required" }, 400);
      const sug = await computeAndStoreSuggestions(supabase, meter.fetch, companyId, statementId);
      const { data: outLines } = await supabase.from("bank_statement_lines").select("*").eq("statement_id", statementId).order("line_no");
      return jsonResponse({ ok: true, statement_id: statementId, lines: outLines ?? [], suggestions: sug, usage: meter.summary() });
    }

    // ----------------------------------------------------------- confirm
    if (action === "confirm") {
      const lineId = String(input.line_id ?? "");
      if (!lineId) return jsonResponse({ ok: false, error: "line_id required" }, 400);
      const { data: line } = await supabase.from("bank_statement_lines").select("*").eq("id", lineId).maybeSingle();
      if (!line) return jsonResponse({ ok: false, error: "line not found" }, 404);
      if (line.status === "posted") return jsonResponse({ ok: false, error: "already posted to Zoho" }, 409);

      if (input.skip) {
        await supabase.from("bank_statement_lines").update({ status: "skipped", decided_by: actor, decided_at: new Date().toISOString() }).eq("id", lineId);
        return jsonResponse({ ok: true, line_id: lineId, status: "skipped" });
      }
      const kind = String(input.chosen_txn_kind ?? "");
      if (!kind) return jsonResponse({ ok: false, error: "chosen_txn_kind required" }, 400);
      if (kind === "exclude" && !line.zoho_uncategorized_id) {
        // File mode has nothing in Zoho to exclude: an excluded line is simply skipped here.
        await supabase.from("bank_statement_lines").update({ status: "skipped", chosen_txn_kind: "exclude", decided_by: actor, decided_at: new Date().toISOString() }).eq("id", lineId);
        return jsonResponse({ ok: true, line_id: lineId, status: "skipped", decision: "filled_blank" });
      }
      const s = (line.suggestion ?? null) as Suggestion | null;
      const rawAlloc = Array.isArray(input.chosen_allocations) ? (input.chosen_allocations as Array<Record<string, unknown>>) : null;
      const allocations = rawAlloc
        ? rawAlloc.map((a) => ({ doc_kind: String(a.doc_kind ?? ""), doc_zoho_id: String(a.doc_zoho_id ?? ""), doc_number: a.doc_number != null ? String(a.doc_number) : null, amount_applied: Math.round(Number(a.amount_applied ?? 0) * 100) / 100 }))
          .filter((a) => a.doc_zoho_id && a.amount_applied > 0)
        : null;
      const bankCharges = input.chosen_bank_charges != null ? Math.round(Number(input.chosen_bank_charges) * 100) / 100 : 0;
      const wantsWriteoff = Boolean(input.chosen_writeoff);
      // Allocations may not exceed what the line brings (plus bank charges
      // the bank kept on a receipt). Never invent money.
      if (allocations) {
        const applied = allocations.reduce((t, a) => t + a.amount_applied, 0);
        const cap = Number(line.amount) + (kind === "customer_payment" || kind === "retainer_receipt" ? bankCharges : 0) + 0.005;
        if (applied > cap) return jsonResponse({ ok: false, error: `Allocations total ${applied.toFixed(2)} but the line brings ${Number(line.amount).toFixed(2)}${bankCharges ? ` + ${bankCharges.toFixed(2)} bank charges` : ""}.` }, 422);
      }
      if (wantsWriteoff) {
        const pol = await loadPolicies(supabase, companyId);
        if (pol.writeoff_after_days == null || pol.writeoff_max_amount == null) return jsonResponse({ ok: false, error: "Set the company's write-off policy first (Bank → Policies) before writing anything off." }, 422);
      }
      const first = allocations?.[0];
      const chosen = {
        chosen_txn_kind: kind,
        chosen_party_kind: input.chosen_party_kind ?? null,
        chosen_party_zoho_id: input.chosen_party_zoho_id ?? null,
        chosen_party_name: input.chosen_party_name ?? null,
        chosen_account_id: input.chosen_account_id ?? null,
        chosen_account_name: input.chosen_account_name ?? null,
        chosen_doc_kind: first?.doc_kind ?? input.chosen_doc_kind ?? null,
        chosen_doc_zoho_id: first?.doc_zoho_id ?? input.chosen_doc_zoho_id ?? null,
        chosen_doc_number: first?.doc_number ?? input.chosen_doc_number ?? null,
        chosen_allocations: allocations,
        chosen_bank_charges: bankCharges || null,
        chosen_writeoff: wantsWriteoff,
        chosen_ref_kind: input.chosen_ref_kind ?? null,
        chosen_ref_zoho_id: input.chosen_ref_zoho_id ?? null,
        chosen_ref_number: input.chosen_ref_number ?? null,
      };
      // Vendor / customer must exist in Zoho Books — never invented here.
      // Known if it is in the synced cache, or if it arrived on an open
      // invoice/bill Zoho itself returned for this line's suggestion.
      if (chosen.chosen_party_zoho_id) {
        const { data: p } = await supabase.from("zoho_entities").select("zoho_id").eq("kind", chosen.chosen_party_kind ?? "vendor").eq("zoho_id", chosen.chosen_party_zoho_id).maybeSingle();
        const fromOpenDoc = s?.source === "open_document" && s.party_zoho_id === chosen.chosen_party_zoho_id;
        if (!p && !fromOpenDoc) return jsonResponse({ ok: false, error: "That party is not in Zoho Books. Create it there, sync, then confirm." }, 422);
      }
      const effAlloc = allocations ?? (chosen.chosen_doc_zoho_id ? [{ doc_zoho_id: chosen.chosen_doc_zoho_id, amount_applied: Number(line.amount) }] : []);
      const sameAlloc = !s ? false : JSON.stringify((s.allocations ?? []).map((a) => [a.doc_zoho_id, a.amount_applied])) === JSON.stringify(effAlloc.map((a) => [a.doc_zoho_id, a.amount_applied]));
      const decision = !s ? "filled_blank"
        : (s.txn_kind === kind && (s.party_zoho_id ?? null) === (chosen.chosen_party_zoho_id ?? null) &&
           (s.account_id ?? null) === (chosen.chosen_account_id ?? null) && (s.ref_zoho_id ?? null) === (chosen.chosen_ref_zoho_id ?? null) &&
           sameAlloc && Math.abs((s.bank_charges ?? 0) - bankCharges) < 0.005 && Boolean(s.writeoff) === wantsWriteoff)
        ? "accepted_suggestion" : "changed_suggestion";
      await supabase.from("bank_statement_lines").update({
        ...chosen, status: "confirmed", decision, decided_by: actor, decided_at: new Date().toISOString(), error: null,
      }).eq("id", lineId);
      return jsonResponse({ ok: true, line_id: lineId, status: "confirmed", decision });
    }

    // -------------------------------------------------------------- push
    if (action === "push") {
      let q = supabase.from("bank_statement_lines").select("*, bank_statements!inner(bank_account_zoho_id, bank_account_name, currency)").eq("status", "confirmed");
      if (input.statement_id) q = q.eq("statement_id", String(input.statement_id));
      if (Array.isArray(input.line_ids) && input.line_ids.length) q = q.in("id", input.line_ids as string[]);
      const { data: lines } = await q.order("line_no");
      if (!lines?.length) return jsonResponse({ ok: true, pushed: 0, failed: 0, results: [], note: "no confirmed lines to push" });
      const token = await getAccessToken(supabase);
      const { data: feeAcct } = await supabase.from("zoho_entities").select("zoho_id").eq("kind", "account").ilike("name", "bank fees%").limit(1).maybeSingle();
      // Period lock (item 10): a line dated inside a locked period must not
      // create anything in the books. Hard per-line refusal; unlock to change.
      const { data: lockRow } = await supabase.from("company_config").select("locked_until").eq("company_id", companyId).maybeSingle();
      const lockedUntil = lockRow?.locked_until ? String(lockRow.locked_until) : null;
      const results: Array<Record<string, unknown>> = [];
      let pushed = 0, failed = 0;
      for (const line of lines) {
        const st = (line as { bank_statements: { bank_account_zoho_id: string; currency: string | null } }).bank_statements;
        try {
          if (lockedUntil && String(line.txn_date) <= lockedUntil && (line as { chosen_txn_kind?: string }).chosen_txn_kind !== "already_recorded") {
            throw new Error(`the books are locked through ${lockedUntil} — this line is dated ${line.txn_date}. Unlock the period to post it.`);
          }
          let r: { zoho_id: string; payload: Record<string, unknown>; extra: Array<{ kind: string; zoho_id: string }>; kind: string };
          if ((line as { zoho_uncategorized_id?: string | null }).zoho_uncategorized_id) {
            // FEED MODE: the line already exists in Zoho — match / categorize / exclude it there.
            const sug = (line.suggestion ?? null) as (Suggestion & { ref_zoho_id?: string | null }) | null;
            const cands = ((line as { zoho_match_candidates?: ZohoMatchCandidate[] | null }).zoho_match_candidates ?? []);
            const matchedType = cands.find((c) => String(c.transaction_id) === String(line.chosen_ref_zoho_id))?.transaction_type ?? null;
            const req = buildFeedRequest({ ...(line as never), matched_transaction_type: matchedType }, st.bank_account_zoho_id, null);
            const res = await meter.fetch(`${apiBase()}/${req.path}?organization_id=${encodeURIComponent(requireEnv("ZOHO_ORGANIZATION_ID"))}`, {
              method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(req.body ? { "Content-Type": "application/json" } : {}) }, body: req.body ? JSON.stringify(req.body) : undefined,
            });
            const raw = await res.json().catch(() => ({})) as Record<string, unknown>;
            if (!res.ok || (raw.code != null && raw.code !== 0)) throw new Error(`Zoho ${req.path.split("/").slice(-1)[0]} rejected: ${raw.message ?? res.status}${raw.code != null ? ` (code ${raw.code})` : ""}`);
            r = { zoho_id: extractZohoId(raw) ?? (req.kind === "match" ? String(line.chosen_ref_zoho_id) : String((line as { zoho_uncategorized_id: string }).zoho_uncategorized_id)), payload: raw, extra: [], kind: req.kind };
            void sug;
          } else {
            r = await pushLine(meter.fetch, apiBase(), requireEnv("ZOHO_ORGANIZATION_ID"), token, line as never, st.bank_account_zoho_id, { bankChargesAccountId: feeAcct?.zoho_id ? String(feeAcct.zoho_id) : null });
          }
          // The statement is the evidence — attach it (file, else a text
          // note with the line) to the record just created. Feed-mode lines
          // already live in Zoho with the bank feed as their source.
          let attach: { attached: boolean; filename?: string; error?: string } | null = null;
          if (!(line as { zoho_uncategorized_id?: string | null }).zoho_uncategorized_id && r.zoho_id && (line as { chosen_txn_kind?: string }).chosen_txn_kind !== "already_recorded") {
            const { data: stmtRow } = await supabase.from("bank_statements").select("bank_account_name, bank_account_zoho_id, period_start, period_end, source, original_name, currency, file_url").eq("id", String((line as { statement_id: string }).statement_id)).maybeSingle();
            if (stmtRow) {
              attach = await attachStatementEvidence(supabase, meter.fetch, token,
                { line_no: Number(line.line_no), txn_date: String(line.txn_date), description: String(line.description ?? ""), reference: (line.reference as string | null) ?? null, side: line.side as "debit" | "credit", amount: Number(line.amount) },
                { bank_account_name: (stmtRow.bank_account_name as string | null) ?? null, bank_account_zoho_id: String(stmtRow.bank_account_zoho_id), period_start: (stmtRow.period_start as string | null) ?? null, period_end: (stmtRow.period_end as string | null) ?? null, source: String(stmtRow.source), original_name: (stmtRow.original_name as string | null) ?? null, currency: (stmtRow.currency as string | null) ?? null, file_url: (stmtRow.file_url as string | null) ?? null },
                String((line as { chosen_txn_kind?: string }).chosen_txn_kind ?? r.kind), r.zoho_id, actor);
            }
          }
          await supabase.from("bank_statement_lines").update({ status: "posted", zoho_txn_id: r.zoho_id, zoho_payload: r.payload, zoho_extra_ids: r.extra, posted_at: new Date().toISOString(), error: null }).eq("id", line.id);
          results.push({ line_id: line.id, line_no: line.line_no, ok: true, zoho_id: r.zoho_id, kind: r.kind, extra: r.extra, attached: attach?.attached ?? null, attach_error: attach && !attach.attached ? attach.error ?? null : null });
          pushed++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await supabase.from("bank_statement_lines").update({ status: "failed", error: message }).eq("id", line.id);
          results.push({ line_id: line.id, line_no: line.line_no, ok: false, error: message });
          failed++;
        }
      }
      return jsonResponse({ ok: failed === 0, pushed, failed, results, usage: meter.summary() });
    }

    // ---------------------------------------------------------- pull_feed
    if (action === "pull_feed") {
      const bankAccountId = String(input.bank_account_zoho_id ?? "").trim();
      if (!bankAccountId) return jsonResponse({ ok: false, error: "bank_account_zoho_id is required — pick the bank account whose Zoho feed to pull" }, 400);
      const token = await getAccessToken(supabase);
      const org = requireEnv("ZOHO_ORGANIZATION_ID");
      const rows: ZohoUncategorizedRow[] = [];
      let page = 1;
      while (page <= 10) {
        const qs = new URLSearchParams({ organization_id: org, account_id: bankAccountId, per_page: "200", page: String(page), ...(input.date_start ? { date_start: String(input.date_start) } : {}) });
        const res = await meter.fetch(`${apiBase()}/banktransactions/uncategorized?${qs}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || (j.code != null && j.code !== 0)) return jsonResponse({ ok: false, error: `Zoho uncategorised list failed: ${j.message ?? res.status}` }, 502);
        rows.push(...(((j as Record<string, unknown>).transactions as ZohoUncategorizedRow[]) ?? []));
        if (!(j as { page_context?: { has_more_page?: boolean } }).page_context?.has_more_page) break;
        page++;
      }
      // Only lines we have not pulled before (any statement, this company).
      const ids = rows.map((r) => String(r.transaction_id));
      const { data: have } = ids.length
        ? await supabase.from("bank_statement_lines").select("zoho_uncategorized_id").eq("company_id", companyId).in("zoho_uncategorized_id", ids)
        : { data: [] };
      const haveSet = new Set((have ?? []).map((h) => String(h.zoho_uncategorized_id)));
      const fresh = rows.filter((r) => !haveSet.has(String(r.transaction_id)));
      const lines = uncategorizedToLines(fresh);
      if (!lines.length) {
        return jsonResponse({ ok: true, statement_id: null, lines: [], line_count: 0, already_pulled: rows.length, note: rows.length ? `all ${rows.length} uncategorised lines were already pulled` : "no uncategorised transactions on this account in Zoho", usage: meter.summary() });
      }
      const { data: acct } = await supabase.from("zoho_entities").select("name, extra").eq("kind", "bank_account").eq("zoho_id", bankAccountId).maybeSingle();
      const dates = lines.map((l) => l.txn_date).sort();
      const { data: st, error: stErr } = await supabase.from("bank_statements").insert({
        company_id: companyId, bank_account_zoho_id: bankAccountId, bank_account_name: acct?.name ?? null,
        source: "zoho_feed", currency: ((acct?.extra as Record<string, unknown> | null)?.currency_code as string | undefined) ?? null,
        period_start: dates[0], period_end: dates[dates.length - 1], line_count: lines.length,
        skipped_rows: [], parse_info: { source: "zoho_feed", pulled: rows.length, new: lines.length, already_pulled: rows.length - fresh.length },
        created_by: actor,
      }).select("id").single();
      if (stErr || !st) throw new Error(`could not save statement: ${stErr?.message}`);
      const { error: lErr } = await supabase.from("bank_statement_lines").insert(lines.map((l) => ({
        statement_id: st.id, company_id: companyId, line_no: l.line_no, txn_date: l.txn_date, value_date: null,
        description: l.description, reference: l.reference, side: l.side, amount: l.amount, balance: null,
        zoho_uncategorized_id: l.zoho_uncategorized_id, zoho_payee: l.zoho_payee,
      })));
      if (lErr) throw new Error(`could not save lines: ${lErr.message}`);
      const sug = await computeAndStoreSuggestions(supabase, meter.fetch, companyId, st.id);
      const { data: outLines } = await supabase.from("bank_statement_lines").select("*").eq("statement_id", st.id).order("line_no");
      return jsonResponse({ ok: true, statement_id: st.id, lines: outLines ?? [], line_count: lines.length, already_pulled: rows.length - fresh.length, suggestions: sug, usage: meter.summary() });
    }

    // ----------------------------------------------- rule proposals (item 3)
    // Which learned patterns are strong enough to become a Zoho bank rule,
    // and creating one — always "recognize" (suggest-only) mode.
    if (action === "rule_proposals") {
      const patterns = await loadPatterns(supabase, companyId);
      const { data: meta } = await supabase.from("bk_bank_patterns").select("id, fingerprint, side, zoho_rule_id, suggestion_status").eq("company_id", companyId);
      const byKey = new Map((meta ?? []).map((m) => [`${m.fingerprint}::${m.side}`, m]));
      const out = patterns.map((p) => {
        const m = byKey.get(`${p.fingerprint}::${p.side}`);
        const v = isProposableAsZohoRule({ ...p, zoho_rule_id: (m?.zoho_rule_id as string | null) ?? null, suggestion_status: (m?.suggestion_status as string) ?? "proposed" });
        return { id: m?.id, fingerprint: p.fingerprint, side: p.side, txn_kind: p.txn_kind, account_name: p.account_name, party_name: p.party_name, sample_size: p.sample_size, confidence: p.confidence, examples: p.examples, zoho_rule_id: m?.zoho_rule_id ?? null, proposable: v.ok, why: v.why, body: v.ok ? zohoRuleBodyForPattern(p) : null };
      }).sort((a, b) => Number(b.proposable) - Number(a.proposable) || b.sample_size - a.sample_size);
      return jsonResponse({ ok: true, proposals: out });
    }
    if (action === "propose_zoho_rule") {
      const patternId = String(input.pattern_id ?? "");
      if (!patternId) return jsonResponse({ ok: false, error: "pattern_id required" }, 400);
      const { data: row } = await supabase.from("bk_bank_patterns").select("*").eq("id", patternId).eq("company_id", companyId).maybeSingle();
      if (!row) return jsonResponse({ ok: false, error: "pattern not found" }, 404);
      const p = { ...(row as unknown as BankPattern), tokens: (row.tokens as string[]) ?? [], examples: (row.examples as string[]) ?? [], confidence: Number(row.confidence), sample_size: Number(row.sample_size), share: Number(row.share) };
      const v = isProposableAsZohoRule({ ...p, zoho_rule_id: row.zoho_rule_id as string | null, suggestion_status: row.suggestion_status as string });
      if (!v.ok) return jsonResponse({ ok: false, error: `Not proposable as a Zoho rule: ${v.why}` }, 422);
      const body = zohoRuleBodyForPattern(p, { bankAccountIds: Array.isArray(input.bank_account_ids) ? (input.bank_account_ids as string[]) : undefined });
      const token = await getAccessToken(supabase);
      const post = async (b: Record<string, unknown>) => {
        const res = await meter.fetch(`${apiBase()}/bankaccounts/rules?organization_id=${encodeURIComponent(requireEnv("ZOHO_ORGANIZATION_ID"))}`, { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(b) });
        const raw = await res.json().catch(() => ({})) as Record<string, unknown>;
        return { ok: res.ok && (raw.code == null || raw.code === 0), status: res.status, raw };
      };
      let sent = body;
      let out = await post(sent);
      // UAE orgs refuse an expense rule without a VAT treatment (code 111865,
      // verified live). Retry once with the org's standard-rate tax.
      if (!out.ok && Number(out.raw.code) === 111865) {
        const { data: taxes } = await supabase.from("zoho_entities").select("zoho_id, name, extra").eq("kind", "tax");
        const std = (taxes ?? []).find((t) => Number((t.extra as Record<string, unknown>)?.percentage ?? (t.extra as Record<string, unknown>)?.tax_percentage) > 0) ?? (taxes ?? [])[0];
        if (std) {
          sent = { ...body, tax_treatment: "vat_registered", tax_id: String(std.zoho_id) };
          out = await post(sent);
        }
      }
      const raw = out.raw;
      if (!out.ok) return jsonResponse({ ok: false, error: `Zoho rejected the rule: ${raw.message ?? out.status}`, body: sent }, 502);
      const rule = (raw.rule ?? raw.bank_rule ?? {}) as Record<string, unknown>;
      const ruleId = rule.rule_id ? String(rule.rule_id) : null;
      await supabase.from("bk_bank_patterns").update({ zoho_rule_id: ruleId ?? "created", zoho_rule_created_at: new Date().toISOString(), zoho_rule_created_by: actor }).eq("id", patternId);
      if (ruleId) await supabase.from("zoho_entities").upsert({ company_id: companyId, kind: "bank_rule", zoho_id: ruleId, name: String(rule.rule_name ?? sent.rule_name), extra: { ...sent, rule_id: ruleId, is_active: true } }, { onConflict: "company_id,kind,zoho_id" });
      return jsonResponse({ ok: true, zoho_rule_id: ruleId, rule, body: sent, usage: meter.summary() });
    }

    // ------------------------------------------------------ party_credits
    // Unused credit a party holds (advances, credit notes / vendor credits)
    // — for the review screen's "apply to this invoice/bill?" prompt.
    if (action === "party_credits") {
      const pk = String(input.party_kind ?? "");
      const pid = String(input.party_zoho_id ?? "");
      if (!pk || !pid) return jsonResponse({ ok: false, error: "party_kind and party_zoho_id required" }, 400);
      const token = await getAccessToken(supabase);
      const credits = (await fetchOpenCredits(meter.fetch, apiBase(), requireEnv("ZOHO_ORGANIZATION_ID"), token))
        .filter((c) => c.party_kind === pk && c.party_zoho_id === pid);
      return jsonResponse({ ok: true, credits, total: credits.reduce((t, c) => t + c.balance, 0), usage: meter.summary() });
    }

    return jsonResponse({ ok: false, error: `unknown action '${action}' — use ingest | pull_feed | suggest | confirm | push | party_credits` }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("bank-statement failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
