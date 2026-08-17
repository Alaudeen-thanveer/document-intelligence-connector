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
//
// The email path calls `ingest` with source 'email' and the body/attachment
// text — same code, different tag.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { GoogleGenerativeAI } from "npm:@google/generative-ai@0.24.1";
import { createZohoMeter, meterContextFromRequest } from "../_shared/zoho_meter.ts";
import { normalizeModelRows, type ParsedLine, type ParseResult, parseStatementText } from "./parse.ts";
import { fetchOpenDocuments, suggestForLines, type LineForSuggest, type OpenDoc, type PartyRef, type Suggestion } from "./suggest.ts";
import { type BankPattern } from "../bookkeeping-learn/bank_patterns.ts";
import { pushLine } from "./push.ts";

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

async function computeAndStoreSuggestions(
  supabase: SupabaseClient, zohoFetch: typeof fetch, companyId: string, statementId: string,
): Promise<{ suggested: number; open: number; open_docs: number }> {
  const { data: lines } = await supabase.from("bank_statement_lines")
    .select("id, line_no, txn_date, description, reference, side, amount").eq("statement_id", statementId).eq("status", "open").order("line_no");
  const list = (lines ?? []) as Array<LineForSuggest & { id: string }>;
  if (!list.length) return { suggested: 0, open: 0, open_docs: 0 };

  const [patterns, parties] = await Promise.all([loadPatterns(supabase, companyId), loadParties(supabase)]);
  let openDocs: OpenDoc[] = [];
  try {
    const token = await getAccessToken(supabase);
    openDocs = await fetchOpenDocuments(zohoFetch, apiBase(), requireEnv("ZOHO_ORGANIZATION_ID"), token);
  } catch (err) {
    console.warn("open documents unavailable; suggesting from patterns only:", err instanceof Error ? err.message : err);
  }
  const suggestions = suggestForLines(list, { patterns, parties, openDocs });
  let suggested = 0;
  for (let i = 0; i < list.length; i++) {
    const s: Suggestion | null = suggestions[i];
    await supabase.from("bank_statement_lines").update({ suggestion: s }).eq("id", list[i].id);
    if (s) suggested++;
  }
  return { suggested, open: list.length - suggested, open_docs: openDocs.length };
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
  const companyId = String(input.company_id ?? DEFAULT_COMPANY);
  const actor = req.headers.get("x-actor")?.trim() || "reviewer";
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
      const s = (line.suggestion ?? null) as Suggestion | null;
      const chosen = {
        chosen_txn_kind: kind,
        chosen_party_kind: input.chosen_party_kind ?? null,
        chosen_party_zoho_id: input.chosen_party_zoho_id ?? null,
        chosen_party_name: input.chosen_party_name ?? null,
        chosen_account_id: input.chosen_account_id ?? null,
        chosen_account_name: input.chosen_account_name ?? null,
        chosen_doc_kind: input.chosen_doc_kind ?? null,
        chosen_doc_zoho_id: input.chosen_doc_zoho_id ?? null,
        chosen_doc_number: input.chosen_doc_number ?? null,
      };
      // Vendor / customer must exist in Zoho Books — never invented here.
      // Known if it is in the synced cache, or if it arrived on an open
      // invoice/bill Zoho itself returned for this line's suggestion.
      if (chosen.chosen_party_zoho_id) {
        const { data: p } = await supabase.from("zoho_entities").select("zoho_id").eq("kind", chosen.chosen_party_kind ?? "vendor").eq("zoho_id", chosen.chosen_party_zoho_id).maybeSingle();
        const fromOpenDoc = s?.source === "open_document" && s.party_zoho_id === chosen.chosen_party_zoho_id;
        if (!p && !fromOpenDoc) return jsonResponse({ ok: false, error: "That party is not in Zoho Books. Create it there, sync, then confirm." }, 422);
      }
      const decision = !s ? "filled_blank"
        : (s.txn_kind === kind && (s.party_zoho_id ?? null) === (chosen.chosen_party_zoho_id ?? null) &&
           (s.account_id ?? null) === (chosen.chosen_account_id ?? null) && (s.doc_zoho_id ?? null) === (chosen.chosen_doc_zoho_id ?? null))
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
      const results: Array<Record<string, unknown>> = [];
      let pushed = 0, failed = 0;
      for (const line of lines) {
        const st = (line as { bank_statements: { bank_account_zoho_id: string; currency: string | null } }).bank_statements;
        try {
          const r = await pushLine(meter.fetch, apiBase(), requireEnv("ZOHO_ORGANIZATION_ID"), token, line as never, st.bank_account_zoho_id);
          await supabase.from("bank_statement_lines").update({ status: "posted", zoho_txn_id: r.zoho_id, zoho_payload: r.payload, posted_at: new Date().toISOString(), error: null }).eq("id", line.id);
          results.push({ line_id: line.id, line_no: line.line_no, ok: true, zoho_id: r.zoho_id, kind: r.kind });
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

    return jsonResponse({ ok: false, error: `unknown action '${action}' — use ingest | suggest | confirm | push` }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("bank-statement failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
