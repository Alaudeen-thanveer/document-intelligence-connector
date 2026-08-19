// Month-end nudges: what a human should look at before closing a period.
// Reads Zoho recurring-journal definitions + journals posted in the month,
// and the expected-but-missing checks a reviewer ENABLED. Lists only —
// this function never posts, creates, or changes anything, in Zoho or here.
//
// Input: { month?: "yyyy-mm" }  (default: current month)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createZohoMeter, meterContextFromRequest } from "../_shared/zoho_meter.ts";
import { isAuthFail, requireUser } from "../_shared/require_user.ts";

/** Set per request; every Zoho call goes through it so usage is metered. */
let zohoFetch: (url: string, init?: RequestInit) => Promise<Response> = fetch;
import {
  type EnabledExpectedMissing,
  type EnabledJournalPattern,
  type EnabledLaterThanUsual,
  expectedBillNudges,
  journalPatternNudges,
  laterThanUsualNudges,
  type OpenDoc,
  type PostedJournal,
  type PostedJournalWithFingerprint,
  type RecurringJournalDef,
  recurringJournalNudges,
  type SeenBill,
} from "./nudges.ts";
import { type Nudge } from "./nudges.ts";
import { reconcileAccount, type ReconResult, type ReconStatementLine, type ReconZohoTxn } from "./reconciliation.ts";
import { buildJournalProposal, journalBody, type PatternForProposal, type ProposalLine } from "./journal_proposals.ts";

/** Same fingerprint as bookkeeping-learn/journal_patterns.ts. */
function fingerprintLines(
  lines: Array<{ account_id: string; debit: number; credit: number }>,
): string {
  const parts = new Set<string>();
  for (const l of lines) {
    if (!l.account_id) continue;
    if (l.debit > 0) parts.add(`${l.account_id}:D`);
    if (l.credit > 0) parts.add(`${l.account_id}:C`);
  }
  return [...parts].sort().join("+");
}

const DEFAULT_COMPANY = "00000000-0000-4000-8000-000000000001";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
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

async function getAccessToken(supabase: SupabaseClient): Promise<string> {
  const existing = Deno.env.get("ZOHO_ACCESS_TOKEN")?.trim();
  if (existing) return existing;
  const { data } = await supabase.from("zoho_oauth_tokens")
    .select("access_token, expires_at").eq("id", 1).maybeSingle();
  if (data?.access_token && new Date(String(data.expires_at)).getTime() > Date.now() + 120_000) {
    return String(data.access_token);
  }
  const accountsUrl = Deno.env.get("ZOHO_ACCOUNTS_URL")?.trim() || "https://accounts.zoho.com";
  const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: requireEnv("ZOHO_REFRESH_TOKEN"),
      client_id: requireEnv("ZOHO_CLIENT_ID"),
      client_secret: requireEnv("ZOHO_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  const payload = await res.json();
  if (!res.ok || !payload?.access_token) {
    throw new Error(`Zoho token refresh failed (${res.status}): ${JSON.stringify(payload)}`);
  }
  const token = String(payload.access_token);
  await supabase.from("zoho_oauth_tokens").upsert({
    id: 1, access_token: token,
    expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  return token;
}

async function zohoGet(token: string, path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams({ organization_id: requireEnv("ZOHO_ORGANIZATION_ID"), ...params });
  const res = await zohoFetch(`${apiBase()}/${path}?${qs}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Zoho ${path} failed (${res.status}): ${JSON.stringify(raw)}`);
  return raw as Record<string, unknown>;
}

async function zohoPost(token: string, path: string, body: unknown): Promise<{ ok: boolean; status: number; raw: Record<string, unknown> }> {
  const qs = new URLSearchParams({ organization_id: requireEnv("ZOHO_ORGANIZATION_ID") });
  const res = await zohoFetch(`${apiBase()}/${path}?${qs}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: res.ok && (raw.code == null || raw.code === 0), status: res.status, raw };
}

/** Zoho bank transactions for one account, newest first, running balances included (no date filter). */
async function fetchAccountTransactions(token: string, accountId: string, maxPages = 3): Promise<ReconZohoTxn[]> {
  const out: ReconZohoTxn[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const raw = await zohoGet(token, "banktransactions", { account_id: accountId, filter_by: "Status.All", per_page: "200", page: String(page) });
    for (const t of (raw.banktransactions ?? []) as Array<Record<string, unknown>>) {
      out.push({
        transaction_id: String(t.transaction_id ?? ""), date: String(t.date ?? "").slice(0, 10), status: String(t.status ?? ""),
        debit_or_credit: String(t.debit_or_credit ?? ""), amount: Number(t.amount ?? 0) || 0,
        running_balance: t.running_balance === "" || t.running_balance == null ? null : Number(t.running_balance),
      });
    }
    const pc = (raw.page_context ?? {}) as Record<string, unknown>;
    if (!pc.has_more_page) break;
  }
  return out.filter((t) => t.transaction_id);
}

/** Latest completed reconciliation end date for an account (null when none). */
async function lastReconciledEnd(token: string, accountId: string): Promise<{ end: string | null; in_progress: boolean }> {
  try {
    const raw = await zohoGet(token, `bankaccounts/${accountId}/reconciliations`);
    const list = ((raw.reconciliations ?? []) as Array<Record<string, unknown>>);
    const done = list.filter((r) => String(r.status ?? "") !== "in_progress").map((r) => String(r.end_date ?? "").slice(0, 10)).filter(Boolean).sort();
    return { end: done.length ? done[done.length - 1] : null, in_progress: list.some((r) => String(r.status ?? "") === "in_progress") };
  } catch {
    return { end: null, in_progress: false };
  }
}

/** Reconciliation status for the company's bank accounts (all, or the given ids). */
async function reconcileForAccounts(supabase: SupabaseClient, token: string, companyId: string, onlyIds: string[] | null, start: string, end: string, today: string): Promise<ReconResult[]> {
  let q = supabase.from("zoho_entities").select("zoho_id, name, extra").eq("kind", "bank_account");
  if (onlyIds) q = q.in("zoho_id", onlyIds);
  const { data: accts } = await q;
  const out: ReconResult[] = [];
  for (const a of accts ?? []) {
    const extra = (a.extra as Record<string, unknown>) ?? {};
    if (extra.is_active === false) continue;
    const accountId = String(a.zoho_id);
    const { data: stmts } = await supabase.from("bank_statements").select("id").eq("company_id", companyId).eq("bank_account_zoho_id", accountId);
    const stmtIds = (stmts ?? []).map((s) => String(s.id));
    const lines: ReconStatementLine[] = [];
    if (stmtIds.length) {
      const { data: rows } = await supabase.from("bank_statement_lines").select("statement_id, txn_date, line_no, side, amount, balance, status").in("statement_id", stmtIds);
      for (const r of rows ?? []) lines.push({ statement_id: String(r.statement_id), txn_date: String(r.txn_date), line_no: Number(r.line_no), side: r.side as "debit" | "credit", amount: Number(r.amount), balance: r.balance == null ? null : Number(r.balance), status: String(r.status) });
    }
    // Accounts the app has never touched and Zoho shows nothing for stay quiet.
    const zoho = await fetchAccountTransactions(token, accountId);
    if (!lines.length && !zoho.length) continue;
    const last = await lastReconciledEnd(token, accountId);
    const result = reconcileAccount({ account: { zoho_id: accountId, name: String(a.name), currency: (extra.currency_code as string | null) ?? null }, period_start: start, period_end: end, today, lines, zoho, last_reconciled_end: last.end });
    if (last.in_progress) { result.can_reconcile = false; result.reconcile_body = null; result.note += " A reconciliation saved earlier in Zoho is still in progress — finish or undo it there first."; }
    out.push(result);
  }
  return out;
}

function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const auth = await requireUser(req, { corsHeaders: CORS_HEADERS });
  if (isAuthFail(auth)) return auth.response;

  let input: {
    month?: string; company_id?: string;
    action?: "nudges" | "reconcile" | "post_journal" | "dismiss_journal";
    bank_account_zoho_id?: string;
    proposal_id?: string;
    journal_date?: string; notes?: string | null; reference_number?: string | null;
    lines?: ProposalLine[];
  } = {};
  try {
    const text = await req.text();
    input = text ? JSON.parse(text) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const today = new Date().toISOString().slice(0, 10);
  const month = /^\d{4}-\d{2}$/.test(input.month ?? "") ? input.month! : today.slice(0, 7);
  const companyId = input.company_id ?? DEFAULT_COMPANY;
  const { start, end } = monthBounds(month);

  try {
    const supabase = getSupabase();
    const meter = createZohoMeter(supabase, {
      ...meterContextFromRequest(req, "month-end", "month-end"),
      company_id: companyId,
    });
    zohoFetch = meter.fetch;
    const token = await getAccessToken(supabase);
    const actor = (auth.user?.email as string | undefined) ?? "reviewer";
    const action = input.action ?? "nudges";

    // ----------------------------------------------------------- actions
    // Reconcile one bank account in Zoho — only what the nudge proposed
    // (recomputed here, never trusted from the client), only when balanced.
    if (action === "reconcile") {
      const accountId = String(input.bank_account_zoho_id ?? "");
      if (!accountId) return jsonResponse({ ok: false, error: "bank_account_zoho_id required" }, 400);
      const recon = await reconcileForAccounts(supabase, token, companyId, [accountId], start, end, today);
      const r = recon[0];
      if (!r) return jsonResponse({ ok: false, error: "bank account not found" }, 404);
      if (!r.can_reconcile || !r.reconcile_body) return jsonResponse({ ok: false, error: `Not ready to reconcile: ${r.note}`, reconciliation: r }, 409);
      const res = await zohoPost(token, `bankaccounts/${accountId}/reconciliations`, r.reconcile_body);
      if (!res.ok) return jsonResponse({ ok: false, error: `Zoho refused the reconciliation: ${res.raw.message ?? res.status}`, reconciliation: r, body: r.reconcile_body }, 502);
      await supabase.from("audit_log").insert({ company_id: companyId, actor_type: "human", actor_id: auth.user?.id ?? null, action: "bank_reconciled", detail: { bank_account_zoho_id: accountId, period: month, closing_balance: r.statement_closing, transactions: (r.reconcile_body.transactions_to_be_reconciled as string[]).length, actor } }).then(() => {}, () => {});
      return jsonResponse({ ok: true, reconciliation: r, zoho: res.raw, usage: meter.summary() });
    }
    // Post a proposed journal (reviewer may have edited amounts/date/notes).
    if (action === "post_journal" || action === "dismiss_journal") {
      const proposalId = String(input.proposal_id ?? "");
      if (!proposalId) return jsonResponse({ ok: false, error: "proposal_id required" }, 400);
      const { data: prop } = await supabase.from("bk_journal_proposals").select("*").eq("id", proposalId).eq("company_id", companyId).maybeSingle();
      if (!prop) return jsonResponse({ ok: false, error: "proposal not found" }, 404);
      if (prop.status === "posted") return jsonResponse({ ok: false, error: `Already posted as Zoho journal ${prop.zoho_journal_id}.` }, 409);
      if (action === "dismiss_journal") {
        await supabase.from("bk_journal_proposals").update({ status: "dismissed", decided_by: actor, decided_at: new Date().toISOString() }).eq("id", proposalId);
        return jsonResponse({ ok: true, status: "dismissed" });
      }
      const lines = (Array.isArray(input.lines) && input.lines.length ? input.lines : (prop.lines as ProposalLine[])).map((l) => ({ ...l, amount: Number(l.amount) }));
      const built = journalBody({ journal_date: input.journal_date ?? String(prop.journal_date), reference_number: input.reference_number === undefined ? (prop.reference_number as string | null) : input.reference_number, notes: input.notes === undefined ? (prop.notes as string | null) : input.notes, lines });
      if (!built.ok) return jsonResponse({ ok: false, error: built.error }, 400);
      const res = await zohoPost(token, "journals", built.body);
      if (!res.ok) return jsonResponse({ ok: false, error: `Zoho refused the journal: ${res.raw.message ?? res.status}`, body: built.body }, 502);
      const journal = (res.raw.journal ?? {}) as Record<string, unknown>;
      const journalId = journal.journal_id ? String(journal.journal_id) : null;
      await supabase.from("bk_journal_proposals").update({ status: "posted", zoho_journal_id: journalId, lines, total: built.total, journal_date: built.body.journal_date, notes: built.body.notes ?? null, reference_number: built.body.reference_number ?? null, decided_by: actor, decided_at: new Date().toISOString() }).eq("id", proposalId);
      await supabase.from("audit_log").insert({ company_id: companyId, actor_type: "human", actor_id: auth.user?.id ?? null, action: "journal_posted", detail: { proposal_id: proposalId, zoho_journal_id: journalId, total: built.total, journal_date: built.body.journal_date, actor } }).then(() => {}, () => {});
      return jsonResponse({ ok: true, zoho_journal_id: journalId, journal, usage: meter.summary() });
    }

    // --- Recurring journals: definitions + what was posted this month ---
    // Soft-fail: some UAE roles/scopes return code 57 on recurringjournals
    // even when journals/bills work. Don't blank the whole Month-end page.
    const warnings: string[] = [];
    let defs: RecurringJournalDef[] = [];
    try {
      const rjRaw = await zohoGet(token, "recurringjournals");
      defs = (
        (rjRaw.recurring_journals ?? rjRaw.recurringjournals ?? []) as Array<
          Record<string, unknown>
        >
      ).map((r) => ({
        recurring_journal_id: String(r.recurring_journal_id ?? ""),
        recurrence_name: String(r.recurrence_name ?? ""),
        recurrence_frequency: String(r.recurrence_frequency ?? "months"),
        repeat_every: Number(r.repeat_every ?? 1) || 1,
        start_date: String(r.start_date ?? "").slice(0, 10),
        end_date: r.end_date ? String(r.end_date).slice(0, 10) : null,
        status: String(r.status ?? "active"),
        total: r.total != null ? Number(r.total) : null,
        next_journal_date: r.next_journal_date
          ? String(r.next_journal_date).slice(0, 10)
          : null,
        last_journal_date: r.last_journal_date
          ? String(r.last_journal_date).slice(0, 10)
          : null,
      })).filter((d) => d.recurring_journal_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("recurringjournals unavailable:", message);
      warnings.push(
        `Declared recurring journals unavailable: ${message}. Other nudges still load.`,
      );
    }

    // Zoho's journals list ignores journal_date_start/end but honours
    // date_start/end (verified on the .ae DC).
    const jRaw = await zohoGet(token, "journals", {
      date_start: start,
      date_end: end,
      per_page: "200",
    });
    const posted: PostedJournal[] = ((jRaw.journals ?? []) as Array<Record<string, unknown>>)
      .map((j) => ({
        journal_id: String(j.journal_id ?? ""),
        journal_date: String(j.journal_date ?? j.date ?? "").slice(0, 10),
        reference_number: j.reference_number != null ? String(j.reference_number) : null,
        notes: j.notes != null ? String(j.notes) : null,
        total: j.total != null ? Number(j.total) : null,
      }));

    // --- Expected bills: ENABLED checks only ---
    const { data: enabledRows } = await supabase
      .from("bk_check_proposals")
      .select("party_zoho_id, party_name, params")
      .eq("company_id", companyId)
      .eq("party_kind", "vendor")
      .eq("check_kind", "expected_missing")
      .eq("status", "enabled");
    const enabled: EnabledExpectedMissing[] = (enabledRows ?? []).map((r) => {
      const p = (r.params ?? {}) as Record<string, unknown>;
      return {
        party_zoho_id: String(r.party_zoho_id),
        party_name: String(r.party_name),
        next_expected: p.next_expected != null ? String(p.next_expected) : null,
        day_min: p.day_min != null ? Number(p.day_min) : null,
        day_max: p.day_max != null ? Number(p.day_max) : null,
      };
    });

    // Bills seen this month: local extracted history (what the app processed)
    // plus Zoho bills for the period (what is actually in the books).
    const seen: SeenBill[] = [];
    if (enabled.length > 0) {
      const { data: docs } = await supabase
        .from("documents").select("id").eq("company_id", companyId);
      const ids = (docs ?? []).map((d) => d.id as string);
      if (ids.length) {
        const { data: ex } = await supabase
          .from("extracted_fields")
          .select("vendor_raw, invoice_date")
          .in("document_id", ids)
          .gte("invoice_date", start)
          .lte("invoice_date", end);
        for (const e of ex ?? []) {
          seen.push({ vendor_zoho_id: null, vendor_name: e.vendor_raw as string | null, invoice_date: e.invoice_date as string | null });
        }
      }
      const bRaw = await zohoGet(token, "bills", { date_start: start, date_end: end, per_page: "200" });
      for (const b of (bRaw.bills ?? []) as Array<Record<string, unknown>>) {
        seen.push({
          vendor_zoho_id: b.vendor_id != null ? String(b.vendor_id) : null,
          vendor_name: b.vendor_name != null ? String(b.vendor_name) : null,
          invoice_date: String(b.date ?? "").slice(0, 10),
        });
      }
    }

    // --- Layer 5: ENABLED undeclared recurring journals, matched by
    // fingerprint against journals posted this month (detail fetch needed
    // for line items; only for the month's journals, so cheap).
    const { data: jpRows } = await supabase
      .from("bk_journal_patterns")
      .select("fingerprint, label, cadence, amount_median, expected_day_min, expected_day_max")
      .eq("company_id", companyId)
      .eq("status", "enabled");
    const enabledPatterns = (jpRows ?? []) as EnabledJournalPattern[];
    let postedWithFp: PostedJournalWithFingerprint[] = [];
    if (enabledPatterns.length > 0 && posted.length > 0) {
      for (const p of posted) {
        try {
          const det = await zohoGet(token, `journals/${p.journal_id}`);
          const j = (det.journal ?? det) as Record<string, unknown>;
          const lines = ((j.line_items as Array<Record<string, unknown>>) ?? []).map((li) => {
            const side = String(li.debit_or_credit ?? "").toLowerCase();
            const amt = Number(li.amount ?? 0) || 0;
            return {
              account_id: String(li.account_id ?? ""),
              debit: Number(li.debit_amount ?? 0) || (side === "debit" ? amt : 0),
              credit: Number(li.credit_amount ?? 0) || (side === "credit" ? amt : 0),
            };
          });
          postedWithFp.push({ ...p, fingerprint: fingerprintLines(lines) });
        } catch {
          postedWithFp.push({ ...p, fingerprint: "" });
        }
      }
    }

    // --- Layer 6: ENABLED later-than-usual — open bills/invoices for those
    // parties, from Zoho (the books are the truth for balances).
    const { data: ltuRows } = await supabase
      .from("bk_check_proposals")
      .select("party_kind, party_zoho_id, party_name, params")
      .eq("company_id", companyId)
      .eq("check_kind", "later_than_usual")
      .eq("status", "enabled");
    const enabledLtu: EnabledLaterThanUsual[] = (ltuRows ?? [])
      .map((r) => {
        const p = (r.params ?? {}) as Record<string, unknown>;
        return {
          party_kind: r.party_kind as "vendor" | "customer",
          party_zoho_id: String(r.party_zoho_id),
          party_name: String(r.party_name),
          pay_lag_p90: Number(p.pay_lag_p90),
          pay_lag_median: p.pay_lag_median != null ? Number(p.pay_lag_median) : null,
        };
      })
      .filter((e) => Number.isFinite(e.pay_lag_p90));
    const openDocs: OpenDoc[] = [];
    if (enabledLtu.length > 0) {
      const wantBills = enabledLtu.some((e) => e.party_kind === "vendor");
      const wantInvoices = enabledLtu.some((e) => e.party_kind === "customer");
      if (wantBills) {
        const b = await zohoGet(token, "bills", { status: "unpaid", per_page: "200" });
        for (const x of (b.bills ?? []) as Array<Record<string, unknown>>) {
          openDocs.push({
            doc_kind: "bill", zoho_id: String(x.bill_id ?? ""), number: x.bill_number != null ? String(x.bill_number) : null,
            party_zoho_id: String(x.vendor_id ?? ""), date: String(x.date ?? "").slice(0, 10), balance: Number(x.balance ?? 0) || 0,
          });
        }
      }
      if (wantInvoices) {
        const i = await zohoGet(token, "invoices", { status: "unpaid", per_page: "200" });
        for (const x of (i.invoices ?? []) as Array<Record<string, unknown>>) {
          openDocs.push({
            doc_kind: "invoice", zoho_id: String(x.invoice_id ?? ""), number: x.invoice_number != null ? String(x.invoice_number) : null,
            party_zoho_id: String(x.customer_id ?? ""), date: String(x.date ?? "").slice(0, 10), balance: Number(x.balance ?? 0) || 0,
          });
        }
      }
    }

    // --- Item 5: from noticing to proposing — a draft journal for every
    // enabled pattern not posted this month. Stored per (pattern, period) so
    // the proposal survives reloads and can never be posted twice.
    const postedFps = new Set(postedWithFp.filter((p) => p.journal_date.slice(0, 7) === month).map((p) => p.fingerprint));
    const { data: fullPatterns } = enabledPatterns.length
      ? await supabase.from("bk_journal_patterns").select("id, fingerprint, label, accounts, amount_median, expected_day_min, expected_day_max, recurring_note").eq("company_id", companyId).eq("status", "enabled")
      : { data: [] as Array<Record<string, unknown>> };
    const { data: existingProps } = await supabase.from("bk_journal_proposals").select("*").eq("company_id", companyId).eq("period", month);
    const propByPattern = new Map((existingProps ?? []).map((r) => [String(r.pattern_id), r]));
    const journalProposals: Array<Record<string, unknown>> = [];
    for (const fp of (fullPatterns ?? []) as Array<Record<string, unknown>>) {
      const existing = propByPattern.get(String(fp.id));
      if (postedFps.has(String(fp.fingerprint)) && !existing) continue; // already in the books this month
      if (existing) { journalProposals.push(existing); continue; }
      const draft = buildJournalProposal({ id: String(fp.id), fingerprint: String(fp.fingerprint), label: String(fp.label), accounts: (fp.accounts as PatternForProposal["accounts"]) ?? [], amount_median: fp.amount_median == null ? null : Number(fp.amount_median), expected_day_min: fp.expected_day_min == null ? null : Number(fp.expected_day_min), expected_day_max: fp.expected_day_max == null ? null : Number(fp.expected_day_max), recurring_note: (fp.recurring_note as string | null) ?? null }, month, today);
      if (!draft) continue;
      const { data: ins } = await supabase.from("bk_journal_proposals").insert({ company_id: companyId, pattern_id: draft.pattern_id, period: month, journal_date: draft.journal_date, reference_number: draft.reference_number, notes: draft.notes, lines: draft.lines, total: draft.total, status: "proposed" }).select("*").maybeSingle();
      if (ins) journalProposals.push(ins);
    }

    // --- Item 4: bank reconciliation at period end, per bank account.
    const reconciliations = await reconcileForAccounts(supabase, token, companyId, null, start, end, today);

    const nudges: Nudge[] = [
      ...recurringJournalNudges(defs, posted, month),
      ...journalPatternNudges(enabledPatterns, postedWithFp, month),
      ...expectedBillNudges(enabled, seen, month, today),
      ...laterThanUsualNudges(enabledLtu, openDocs, today),
      ...reconciliations.map((r): Nudge => ({
        kind: "bank_reconciliation",
        severity: r.status === "balanced" || r.status === "no_book" ? "info" : "attention",
        title: `${r.account.name} — ${r.status === "balanced" ? "ready to reconcile" : r.status === "no_statement" ? "no statement balance on file" : r.status === "no_book" ? "nothing in Zoho yet" : r.status === "pending" ? "lines still pending" : `differs by ${r.difference?.toFixed(2)}`}`,
        detail: r.note,
        key: `recon:${r.account.zoho_id}:${month}`,
        ref: { bank_account_zoho_id: r.account.zoho_id, status: r.status, difference: r.difference, can_reconcile: r.can_reconcile },
      })),
    ];
    const attention = nudges.filter((n) => n.severity === "attention");

    return jsonResponse({
      ok: true,
      month,
      today,
      summary: {
        recurring_journal_definitions: defs.length,
        journals_posted_this_month: posted.length,
        expected_bill_checks_enabled: enabled.length,
        journal_patterns_enabled: enabledPatterns.length,
        later_than_usual_enabled: enabledLtu.length,
        needs_attention: attention.length,
      },
      nudges,
      journal_proposals: journalProposals,
      reconciliations,
      warnings: warnings.length ? warnings : undefined,
      usage: meter.summary(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("month-end failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
