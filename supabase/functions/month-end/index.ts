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
import { computeCtProvision, fiscalYearStart, netProfitFromReport } from "./ct_provision.ts";
import { bcaBody, bcaParams, parseBcaAccounts, validateRate } from "./fx_reval.ts";
import { dueScheduleEntries, faDepreciationNudge, validateSchedule, type ScheduleRow } from "./schedules.ts";
import { findDuplicateAccounts, findDuplicateContacts, findMissingTrns, findSuspenseBalances, unusedAccountCandidates, type HygieneAccount, type HygieneContact } from "./hygiene.ts";
import { companyForCaller, isCompanyFail } from "../_shared/tenant.ts";
import { zohoAuthFor, type ZohoAuth } from "../_shared/zoho_auth.ts";

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

/**
 * The company's own Zoho organisation and a z for it. This used to read
 * ZOHO_REFRESH_TOKEN and ZOHO_ORGANIZATION_ID from the environment, which is
 * one organisation for the whole deployment — see _shared/zoho_auth.ts.
 */
async function getAccessToken(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ZohoAuth> {
  return await zohoAuthFor(supabase, companyId);
}

async function zohoGet(z: ZohoAuth, path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams({ organization_id: z.organizationId, ...params });
  const res = await zohoFetch(`${z.apiBase}/${path}?${qs}`, {
    headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
  });
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Zoho ${path} failed (${res.status}): ${JSON.stringify(raw)}`);
  return raw as Record<string, unknown>;
}

async function zohoPost(z: ZohoAuth, path: string, body: unknown): Promise<{ ok: boolean; status: number; raw: Record<string, unknown> }> {
  const qs = new URLSearchParams({ organization_id: z.organizationId });
  const res = await zohoFetch(`${z.apiBase}/${path}?${qs}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: res.ok && (raw.code == null || raw.code === 0), status: res.status, raw };
}

/** Zoho bank transactions for one account, newest first, running balances included (no date filter). */
async function fetchAccountTransactions(z: ZohoAuth, accountId: string, maxPages = 3): Promise<ReconZohoTxn[]> {
  const out: ReconZohoTxn[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const raw = await zohoGet(z, "banktransactions", { account_id: accountId, filter_by: "Status.All", per_page: "200", page: String(page) });
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
async function lastReconciledEnd(z: ZohoAuth, accountId: string): Promise<{ end: string | null; in_progress: boolean }> {
  try {
    const raw = await zohoGet(z, `bankaccounts/${accountId}/reconciliations`);
    const list = ((raw.reconciliations ?? []) as Array<Record<string, unknown>>);
    const done = list.filter((r) => String(r.status ?? "") !== "in_progress").map((r) => String(r.end_date ?? "").slice(0, 10)).filter(Boolean).sort();
    return { end: done.length ? done[done.length - 1] : null, in_progress: list.some((r) => String(r.status ?? "") === "in_progress") };
  } catch {
    return { end: null, in_progress: false };
  }
}

/** Reconciliation status for the company's bank accounts (all, or the given ids). */
async function reconcileForAccounts(supabase: SupabaseClient, z: ZohoAuth, companyId: string, onlyIds: string[] | null, start: string, end: string, today: string): Promise<ReconResult[]> {
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
    const zoho = await fetchAccountTransactions(z, accountId);
    if (!lines.length && !zoho.length) continue;
    const last = await lastReconciledEnd(z, accountId);
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
    action?: "nudges" | "reconcile" | "post_journal" | "dismiss_journal" | "lock_period" | "unlock_period" | "fx_exposure" | "post_bca" | "save_schedule" | "dismiss_schedule" | "create_asset" | "dismiss_asset";
    bank_account_zoho_id?: string;
    proposal_id?: string;
    journal_date?: string; notes?: string | null; reference_number?: string | null;
    lines?: ProposalLine[];
    /** lock_period: lock despite blockers (audited with them). */
    force?: boolean;
    /** fx_exposure / post_bca. */
    currency_id?: string;
    exchange_rate?: number | string;
    adjustment_date?: string;
    account_ids?: string[];
    /** save_schedule / dismiss_schedule. */
    schedule_id?: string;
    schedule?: { kind: "prepayment" | "accrual"; label: string; bs_account_id: string; pl_account_id: string; total: number; months: number; start_period: string };
    /** create_asset / dismiss_asset. */
    asset_proposal_id?: string;
    fixed_asset_type_id?: string;
  } = {};
  try {
    const text = await req.text();
    input = text ? JSON.parse(text) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const today = new Date().toISOString().slice(0, 10);
  const month = /^\d{4}-\d{2}$/.test(input.month ?? "") ? input.month! : today.slice(0, 7);
  // Runs with the service role, so nothing below checks who is asking
  // unless this does. No default company: a fallback is how a bug
  // becomes a cross-client leak instead of an error.
  const tenant = await companyForCaller(auth, {
    companyId: input.company_id ?? null,
    errorBody: (m) => ({ error: m }),
  });
  if (isCompanyFail(tenant)) return tenant.response;
  const companyId = tenant.companyId;
  const { start, end } = monthBounds(month);

  try {
    const supabase = getSupabase();
    const meter = createZohoMeter(supabase, {
      ...meterContextFromRequest(req, "month-end", "month-end"),
      company_id: companyId,
    });
    zohoFetch = meter.fetch;
    const z = await getAccessToken(supabase, companyId);
    const actor = (auth.user?.email as string | undefined) ?? "reviewer";
    const action = input.action ?? "nudges";
    const { data: cfg } = await supabase.from("company_config")
      .select("locked_until, ct_rate, ct_threshold, ct_expense_account_id, ct_payable_account_id")
      .eq("company_id", companyId).maybeSingle();
    const lockedUntil: string | null = cfg?.locked_until ? String(cfg.locked_until) : null;
    const audit = (act: string, detail: Record<string, unknown>) =>
      supabase.from("audit_log").insert({ company_id: companyId, actor_type: "human", actor_id: auth.user?.id ?? null, action: act, detail: { ...detail, actor } }).then(() => {}, () => {});

    // ------------------------------------------- period lock (item 10)
    // Zoho's .ae API exposes no transaction-locking endpoint (verified), so
    // the lock is the app's: nothing may post into the books on or before
    // locked_until through this app. The lock is hard — no per-action
    // override; unlock (audited) to change history.
    if (action === "lock_period") {
      const recons = await reconcileForAccounts(supabase, z, companyId, null, start, end, today);
      const blockers: string[] = [];
      if (end >= today) blockers.push(`the period ${month} has not ended yet`);
      for (const r of recons) {
        if (r.status === "differs") blockers.push(`${r.account.name}: statement and books differ by ${r.difference?.toFixed(2)}`);
        if (r.status === "pending") blockers.push(`${r.account.name}: ${r.unposted_lines + r.uncategorised_in_zoho} line(s) still pending`);
        if (r.status === "no_statement" && r.unposted_lines > 0) blockers.push(`${r.account.name}: ${r.unposted_lines} statement line(s) not yet posted`);
      }
      const { data: openProps } = await supabase.from("bk_journal_proposals").select("id").eq("company_id", companyId).eq("period", month).eq("status", "proposed");
      if (openProps?.length) blockers.push(`${openProps.length} journal proposal(s) still awaiting a decision`);
      if (blockers.length && !input.force) {
        return jsonResponse({ ok: false, error: "Not everything is settled — lock anyway with force, or finish these first.", blockers }, 409);
      }
      if (lockedUntil && lockedUntil >= end) return jsonResponse({ ok: false, error: `Already locked through ${lockedUntil}.` }, 409);
      await supabase.from("company_config").update({ locked_until: end }).eq("company_id", companyId);
      await audit("period_locked", { locked_until: end, period: month, forced: Boolean(input.force && blockers.length), blockers });
      return jsonResponse({ ok: true, locked_until: end, forced: Boolean(input.force && blockers.length), blockers });
    }
    if (action === "unlock_period") {
      if (!lockedUntil) return jsonResponse({ ok: false, error: "Nothing is locked." }, 409);
      await supabase.from("company_config").update({ locked_until: null }).eq("company_id", companyId);
      await audit("period_unlocked", { was_locked_until: lockedUntil });
      return jsonResponse({ ok: true, was_locked_until: lockedUntil });
    }

    // --------------------------------- multi-currency revaluation (item 11)
    // Zoho computes the revaluation; the reviewer owns the period-end rate.
    if (action === "fx_exposure" || action === "post_bca") {
      const currencyId = String(input.currency_id ?? "");
      if (!currencyId) return jsonResponse({ ok: false, error: "currency_id required" }, 400);
      const rateCheck = validateRate(input.exchange_rate);
      if (!rateCheck.ok) return jsonResponse({ ok: false, error: rateCheck.error }, 400);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(input.adjustment_date ?? "") ? String(input.adjustment_date) : (end <= today ? end : today);
      if (lockedUntil && date <= lockedUntil) return jsonResponse({ ok: false, error: `The books are locked through ${lockedUntil} — an adjustment dated ${date} cannot go in.` }, 409);
      const curRaw = await zohoGet(z, "settings/currencies");
      const cur = ((curRaw.currencies ?? []) as Array<Record<string, unknown>>).find((c) => String(c.currency_id) === currencyId);
      if (!cur) return jsonResponse({ ok: false, error: "Unknown currency." }, 404);
      if (cur.is_base_currency) return jsonResponse({ ok: false, error: "That is the base currency — nothing to revalue." }, 400);
      const params = bcaParams(currencyId, date, rateCheck.rate, `Period-end revaluation ${month} via connector`);
      const accRaw = await zohoGet(z, "basecurrencyadjustment/accounts", params);
      const exposure = parseBcaAccounts(currencyId, String(cur.currency_code ?? ""), Number(cur.exchange_rate ?? 0) || null, accRaw);
      if (action === "fx_exposure") {
        return jsonResponse({ ok: true, exposure, adjustment_date: date, exchange_rate: rateCheck.rate, usage: meter.summary() });
      }
      // post_bca: only accounts Zoho itself listed (optionally narrowed by the reviewer).
      const eligible = exposure.accounts.map((a) => a.account_id);
      const chosen = Array.isArray(input.account_ids) && input.account_ids.length ? input.account_ids.filter((id) => eligible.includes(String(id))) : eligible;
      if (!chosen.length) return jsonResponse({ ok: false, error: `Zoho reports no accounts to revalue for ${exposure.currency_code} at ${rateCheck.rate} on ${date}.`, exposure }, 409);
      // Verified live on the .ae DC: the entity goes in the JSON body and
      // account_ids goes in the QUERY string (comma-separated) — the only
      // combination Zoho accepts.
      const qs = new URLSearchParams({ organization_id: z.organizationId, ...bcaBody(chosen) as Record<string, string> });
      const res = await zohoFetch(`${z.apiBase}/basecurrencyadjustment?${qs}`, { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ currency_id: currencyId, adjustment_date: date, exchange_rate: rateCheck.rate, notes: params.notes }) });
      const raw = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok || (raw.code != null && raw.code !== 0)) return jsonResponse({ ok: false, error: `Zoho refused the adjustment: ${raw.message ?? res.status}`, exposure }, 502);
      const bca = (raw.base_currency_adjustment ?? raw.data ?? {}) as Record<string, unknown>;
      await audit("fx_revaluation_posted", { currency: exposure.currency_code, exchange_rate: rateCheck.rate, adjustment_date: date, accounts: chosen.length, zoho_id: bca.base_currency_adjustment_id ?? null });
      return jsonResponse({ ok: true, zoho: bca, exposure, usage: meter.summary() });
    }

    // -------------------------- prepayment / accrual schedules (item 16)
    // save_schedule activates a proposed one (with the reviewer's months /
    // start / P&L account) or creates a manual accrual/prepayment.
    if (action === "save_schedule") {
      const body = input.schedule;
      if (!body) return jsonResponse({ ok: false, error: "schedule required" }, 400);
      const v = validateSchedule(body);
      if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);
      const { data: accs } = await supabase.from("zoho_entities").select("zoho_id, name").eq("kind", "account").in("zoho_id", [body.bs_account_id, body.pl_account_id]);
      const nameOf = (id: string) => (accs ?? []).find((a) => String(a.zoho_id) === id)?.name ?? null;
      if (!nameOf(body.bs_account_id) || !nameOf(body.pl_account_id)) return jsonResponse({ ok: false, error: "Pick accounts that exist in Zoho Books (synced)." }, 400);
      const row = {
        kind: body.kind, label: body.label.trim(), bs_account_id: body.bs_account_id, bs_account_name: nameOf(body.bs_account_id),
        pl_account_id: body.pl_account_id, pl_account_name: nameOf(body.pl_account_id),
        total: Math.round(Number(body.total) * 100) / 100, months: Math.round(Number(body.months)), start_period: body.start_period,
        status: "active", decided_by: actor, decided_at: new Date().toISOString(),
      };
      let saved: Record<string, unknown> | null = null;
      if (input.schedule_id) {
        const { data } = await supabase.from("bk_schedules").update(row).eq("id", input.schedule_id).eq("company_id", companyId).in("status", ["proposed", "active"]).select("*").maybeSingle();
        saved = data;
      } else {
        const { data } = await supabase.from("bk_schedules").insert({ ...row, company_id: companyId, source_kind: "manual", created_by: actor }).select("*").maybeSingle();
        saved = data;
      }
      if (!saved) return jsonResponse({ ok: false, error: "Schedule not found (or already done/dismissed)." }, 404);
      await audit("schedule_activated", { schedule_id: saved.id, kind: row.kind, label: row.label, total: row.total, months: row.months, start_period: row.start_period });
      return jsonResponse({ ok: true, schedule: saved });
    }
    if (action === "dismiss_schedule") {
      const sid = String(input.schedule_id ?? "");
      if (!sid) return jsonResponse({ ok: false, error: "schedule_id required" }, 400);
      const { data } = await supabase.from("bk_schedules").update({ status: "dismissed", decided_by: actor, decided_at: new Date().toISOString() }).eq("id", sid).eq("company_id", companyId).neq("status", "done").select("id").maybeSingle();
      if (!data) return jsonResponse({ ok: false, error: "Schedule not found (or already done)." }, 404);
      return jsonResponse({ ok: true, status: "dismissed" });
    }

    // ------------------------------------------- fixed assets (item 16)
    // create_asset posts the proposed record into Zoho's Fixed Assets
    // module — only on this click, never on its own. Zoho's own message is
    // surfaced verbatim (e.g. when the module is disabled).
    if (action === "create_asset") {
      const pid = String(input.asset_proposal_id ?? "");
      if (!pid) return jsonResponse({ ok: false, error: "asset_proposal_id required" }, 400);
      const { data: prop } = await supabase.from("bk_asset_proposals").select("*").eq("id", pid).eq("company_id", companyId).maybeSingle();
      if (!prop) return jsonResponse({ ok: false, error: "proposal not found" }, 404);
      if (prop.status === "created") return jsonResponse({ ok: false, error: `Already created as Zoho asset ${prop.zoho_asset_id}.` }, 409);
      const purchaseDate = prop.purchase_date ? String(prop.purchase_date) : today;
      // Field names per the Fixed Assets API (total_life is MONTHS); the
      // asset type supplies the depreciation defaults.
      const body: Record<string, unknown> = {
        asset_name: String(prop.line_description).slice(0, 100),
        asset_account_id: String(prop.asset_account_id),
        asset_cost: Number(prop.amount),
        dep_start_value: Number(prop.amount),
        asset_purchase_date: purchaseDate,
        depreciation_start_date: purchaseDate,
        ...(input.fixed_asset_type_id ? { fixed_asset_type_id: String(input.fixed_asset_type_id) } : {}),
        notes: `Created by the connector from bill ${prop.bill_number ?? prop.bill_zoho_id}; confirmed by ${actor}.`,
      };
      const res = await zohoPost(z, "fixedassets", body);
      if (!res.ok) return jsonResponse({ ok: false, error: `Zoho did not create the asset: ${res.raw.message ?? res.status}`, body }, 502);
      const asset = (res.raw.fixed_asset ?? res.raw.fixedasset ?? {}) as Record<string, unknown>;
      const assetId = asset.fixed_asset_id ? String(asset.fixed_asset_id) : null;
      // Zoho creates the asset as a draft; the reviewer's click IS the
      // confirmation, so activate it (verified live: POST …/status/active).
      // Best effort — a draft asset is still a created asset.
      let activated = false;
      if (assetId) {
        const act = await zohoPost(z, `fixedassets/${assetId}/status/active`, {});
        activated = act.ok;
      }
      await supabase.from("bk_asset_proposals").update({ status: "created", zoho_asset_id: assetId, decided_by: actor, decided_at: new Date().toISOString() }).eq("id", pid);
      await audit("fixed_asset_created", { proposal_id: pid, zoho_asset_id: assetId, asset_name: body.asset_name, amount: prop.amount, activated });
      return jsonResponse({ ok: true, zoho_asset_id: assetId, activated, asset, usage: meter.summary() });
    }
    if (action === "dismiss_asset") {
      const pid = String(input.asset_proposal_id ?? "");
      if (!pid) return jsonResponse({ ok: false, error: "asset_proposal_id required" }, 400);
      const { data } = await supabase.from("bk_asset_proposals").update({ status: "dismissed", decided_by: actor, decided_at: new Date().toISOString() }).eq("id", pid).eq("company_id", companyId).neq("status", "created").select("id").maybeSingle();
      if (!data) return jsonResponse({ ok: false, error: "Proposal not found (or already created)." }, 404);
      return jsonResponse({ ok: true, status: "dismissed" });
    }

    // ----------------------------------------------------------- actions
    // Reconcile one bank account in Zoho — only what the nudge proposed
    // (recomputed here, never trusted from the client), only when balanced.
    if (action === "reconcile") {
      const accountId = String(input.bank_account_zoho_id ?? "");
      if (!accountId) return jsonResponse({ ok: false, error: "bank_account_zoho_id required" }, 400);
      const recon = await reconcileForAccounts(supabase, z, companyId, [accountId], start, end, today);
      const r = recon[0];
      if (!r) return jsonResponse({ ok: false, error: "bank account not found" }, 404);
      if (!r.can_reconcile || !r.reconcile_body) return jsonResponse({ ok: false, error: `Not ready to reconcile: ${r.note}`, reconciliation: r }, 409);
      const res = await zohoPost(z, `bankaccounts/${accountId}/reconciliations`, r.reconcile_body);
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
      if (lockedUntil && String(built.body.journal_date) <= lockedUntil) {
        return jsonResponse({ ok: false, error: `The books are locked through ${lockedUntil} — a journal dated ${built.body.journal_date} cannot go in. Date it later, or unlock the period first.` }, 409);
      }
      const res = await zohoPost(z, "journals", built.body);
      if (!res.ok) return jsonResponse({ ok: false, error: `Zoho refused the journal: ${res.raw.message ?? res.status}`, body: built.body }, 502);
      const journal = (res.raw.journal ?? {}) as Record<string, unknown>;
      const journalId = journal.journal_id ? String(journal.journal_id) : null;
      await supabase.from("bk_journal_proposals").update({ status: "posted", zoho_journal_id: journalId, lines, total: built.total, journal_date: built.body.journal_date, notes: built.body.notes ?? null, reference_number: built.body.reference_number ?? null, decided_by: actor, decided_at: new Date().toISOString() }).eq("id", proposalId);
      // A schedule whose every month has posted is done.
      if (prop.schedule_id) {
        const { data: sched } = await supabase.from("bk_schedules").select("months").eq("id", prop.schedule_id).maybeSingle();
        const { data: postedRows } = await supabase.from("bk_journal_proposals").select("id").eq("schedule_id", prop.schedule_id).eq("status", "posted");
        if (sched && (postedRows ?? []).length >= Number(sched.months)) {
          await supabase.from("bk_schedules").update({ status: "done" }).eq("id", prop.schedule_id);
        }
      }
      await supabase.from("audit_log").insert({ company_id: companyId, actor_type: "human", actor_id: auth.user?.id ?? null, action: "journal_posted", detail: { proposal_id: proposalId, zoho_journal_id: journalId, total: built.total, journal_date: built.body.journal_date, actor } }).then(() => {}, () => {});
      return jsonResponse({ ok: true, zoho_journal_id: journalId, journal, usage: meter.summary() });
    }

    // --- Recurring journals: definitions + what was posted this month ---
    // Soft-fail: some UAE roles/scopes return code 57 on recurringjournals
    // even when journals/bills work. Don't blank the whole Month-end page.
    const warnings: string[] = [];
    let defs: RecurringJournalDef[] = [];
    try {
      const rjRaw = await zohoGet(z, "recurringjournals");
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
    const jRaw = await zohoGet(z, "journals", {
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
      const bRaw = await zohoGet(z, "bills", { date_start: start, date_end: end, per_page: "200" });
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
          const det = await zohoGet(z, `journals/${p.journal_id}`);
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
        const b = await zohoGet(z, "bills", { status: "unpaid", per_page: "200" });
        for (const x of (b.bills ?? []) as Array<Record<string, unknown>>) {
          openDocs.push({
            doc_kind: "bill", zoho_id: String(x.bill_id ?? ""), number: x.bill_number != null ? String(x.bill_number) : null,
            party_zoho_id: String(x.vendor_id ?? ""), date: String(x.date ?? "").slice(0, 10), balance: Number(x.balance ?? 0) || 0,
          });
        }
      }
      if (wantInvoices) {
        const i = await zohoGet(z, "invoices", { status: "unpaid", per_page: "200" });
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

    // --- Item 12: corporate tax provision — schedule-driven, rides on the
    // journal-proposal machinery (kind ct_provision). Proposed only when the
    // company chose its two accounts; a loss or sub-threshold profit reports
    // why and proposes nothing.
    let ct: Record<string, unknown> | null = null;
    if (cfg?.ct_expense_account_id && cfg?.ct_payable_account_id) {
      try {
        const orgRaw = await zohoGet(z, `organizations/${z.organizationId}`);
        const fyName = String(((orgRaw.organization ?? {}) as Record<string, unknown>).fiscal_year_start_month ?? "january").toLowerCase();
        const fyMonth = ["january","february","march","april","may","june","july","august","september","october","november","december"].indexOf(fyName) + 1;
        const fyStart = fiscalYearStart(end, fyMonth || 1);
        const plRaw = await zohoGet(z, "reports/profitandloss", { from_date: fyStart, to_date: end <= today ? end : today });
        const netProfit = netProfitFromReport((plRaw.profit_and_loss ?? []) as Array<{ name?: string; total?: number }>);
        const { data: acctRows } = await supabase.from("zoho_entities").select("zoho_id, name").eq("kind", "account").in("zoho_id", [cfg.ct_expense_account_id, cfg.ct_payable_account_id]);
        const acctName = (id: string) => (acctRows ?? []).find((a) => String(a.zoho_id) === id)?.name ?? null;
        const { data: provided } = await supabase.from("bk_journal_proposals").select("total, period").eq("company_id", companyId).eq("kind", "ct_provision").eq("status", "posted").gte("period", fyStart.slice(0, 7));
        const already = (provided ?? []).filter((r) => String(r.period) !== month).reduce((t, r) => t + Number(r.total ?? 0), 0);
        const result = computeCtProvision({
          settings: { rate: Number(cfg.ct_rate ?? 9), threshold: Number(cfg.ct_threshold ?? 375000), expense_account_id: String(cfg.ct_expense_account_id), payable_account_id: String(cfg.ct_payable_account_id), expense_account_name: acctName(String(cfg.ct_expense_account_id)), payable_account_name: acctName(String(cfg.ct_payable_account_id)) },
          net_profit_ytd: netProfit ?? 0, already_provided: already, period: month, fy_start: fyStart,
        });
        ct = { ...result, fy_start: fyStart, net_profit_source: netProfit == null ? "not found in the P&L report" : "Zoho P&L report" };
        const { data: existingCt } = await supabase.from("bk_journal_proposals").select("*").eq("company_id", companyId).eq("kind", "ct_provision").eq("period", month).maybeSingle();
        if (existingCt) journalProposals.push(existingCt);
        else if (result.lines && result.top_up > 0) {
          const { data: ins } = await supabase.from("bk_journal_proposals").insert({
            company_id: companyId, pattern_id: null, kind: "ct_provision", period: month,
            journal_date: end <= today ? end : today, reference_number: `DIC-CT-${month}`,
            notes: result.notes, lines: result.lines, total: result.top_up, status: "proposed",
          }).select("*").maybeSingle();
          if (ins) journalProposals.push(ins);
        }
      } catch (err) {
        ct = { applicable: false, reason: `Corporate tax check unavailable: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // --- Item 16: schedules — every due month of an active schedule
    // becomes a journal proposal (kind schedule), never twice per period.
    const { data: schedRows } = await supabase.from("bk_schedules").select("*").eq("company_id", companyId).in("status", ["proposed", "active"]);
    const schedules: Array<Record<string, unknown>> = [];
    for (const sr of schedRows ?? []) {
      const { data: props } = await supabase.from("bk_journal_proposals").select("period, status").eq("schedule_id", sr.id);
      const proposedPeriods = (props ?? []).map((x) => String(x.period));
      const postedCount = (props ?? []).filter((x) => x.status === "posted").length;
      let created = 0;
      if (sr.status === "active") {
        const row: ScheduleRow = { id: String(sr.id), kind: sr.kind as "prepayment" | "accrual", label: String(sr.label), bs_account_id: String(sr.bs_account_id), bs_account_name: (sr.bs_account_name as string | null) ?? null, pl_account_id: String(sr.pl_account_id), pl_account_name: (sr.pl_account_name as string | null) ?? null, total: Number(sr.total), months: Number(sr.months), start_period: String(sr.start_period) };
        for (const due of dueScheduleEntries(row, proposedPeriods, month, today)) {
          const { data: ins, error: insErr } = await supabase.from("bk_journal_proposals").insert({
            company_id: companyId, pattern_id: null, kind: "schedule", schedule_id: sr.id, period: due.period,
            journal_date: due.journal_date, reference_number: due.reference_number, notes: due.notes,
            lines: due.lines, total: due.amount, status: "proposed",
          }).select("*").maybeSingle();
          if (ins) { journalProposals.push(ins); created++; }
          else if (insErr) console.warn(`schedule entry insert failed (${sr.label} ${due.period}): ${insErr.message}`);
        }
      }
      schedules.push({ ...sr, proposed_periods: proposedPeriods.length + created, posted_periods: postedCount });
    }
    // Schedule entries still awaiting a decision (ANY period — an unposted
    // June release is still June's business) plus this period's decided ones.
    const { data: schedProps } = await supabase.from("bk_journal_proposals").select("*").eq("company_id", companyId).eq("kind", "schedule").or(`status.eq.proposed,period.eq.${month}`);
    for (const spx of schedProps ?? []) if (!journalProposals.some((jp) => (jp as { id?: string }).id === spx.id)) journalProposals.push(spx);

    // Asset proposals (from approved bills) + "did depreciation run?".
    const { data: assetProps } = await supabase.from("bk_asset_proposals").select("*").eq("company_id", companyId).order("created_at", { ascending: false });
    let faAssetsCount = 0;
    let faTypes: Array<Record<string, unknown>> = [];
    try {
      const faRaw = await zohoGet(z, "fixedassets", { filter_by: "Status.Active", per_page: "200" });
      faAssetsCount = ((faRaw.fixedassets ?? []) as Array<unknown>).length;
      const tRaw = await zohoGet(z, "fixedassettypes");
      faTypes = ((tRaw.fixed_asset_types ?? []) as Array<Record<string, unknown>>).map((t) => ({ fixed_asset_type_id: t.fixed_asset_type_id, name: t.fixed_asset_type_name ?? t.name }));
    } catch { /* module off or unreachable — the create action reports Zoho's words */ }
    const faNudge = faDepreciationNudge(faAssetsCount, posted, month);

    // --- Books hygiene: suspense balances, duplicate/TRN-less contacts,
    // duplicate/unused accounts. Lists with plain-English notes; a human
    // tidies in Zoho. Only the suspense balances get an attention nudge.
    let hygiene: Record<string, unknown> = {};
    let suspenseNudges: Nudge[] = [];
    try {
      const coaRaw = await zohoGet(z, "chartofaccounts", { showbalance: "true", per_page: "200" });
      const accounts: HygieneAccount[] = ((coaRaw.chartofaccounts ?? []) as Array<Record<string, unknown>>).map((a) => ({
        account_id: String(a.account_id ?? ""), account_name: String(a.account_name ?? ""), account_type: String(a.account_type ?? ""),
        current_balance: Number(a.current_balance ?? 0) || 0, is_active: Boolean(a.is_active ?? true),
        is_user_created: Boolean(a.is_user_created ?? false), is_system_account: Boolean(a.is_system_account ?? false),
      }));
      const { data: partyRows } = await supabase.from("zoho_entities").select("kind, zoho_id, name, extra").in("kind", ["vendor", "customer"]);
      const contacts: HygieneContact[] = (partyRows ?? []).map((r) => {
        const e = (r.extra as Record<string, unknown>) ?? {};
        return { zoho_id: String(r.zoho_id), name: String(r.name), kind: r.kind as "vendor" | "customer", trn: (e.tax_reg_no as string | null) ?? null, tax_treatment: (e.tax_treatment as string | null) ?? null, status: (e.status as string | null) ?? null };
      });
      const suspense = findSuspenseBalances(accounts);
      // "Unused" is only claimed after Zoho confirms no transactions ever —
      // a zero balance alone can just mean fully settled. Capped politely.
      const candidates = unusedAccountCandidates(accounts).slice(0, 30);
      const unused: Array<{ account_id: string; account_name: string; note: string }> = [];
      for (const c of candidates) {
        try {
          const txRaw = await zohoGet(z, "chartofaccounts/transactions", { account_id: c.account_id, per_page: "1" });
          const any = (((txRaw.transactions ?? []) as Array<unknown>).length) > 0;
          if (!any) unused.push({ account_id: c.account_id, account_name: c.account_name, note: `${c.account_name} has never been posted to — deactivate it in Zoho if it was created by mistake.` });
        } catch { break; /* endpoint unavailable — say nothing rather than guess */ }
      }
      hygiene = {
        suspense,
        duplicate_contacts: findDuplicateContacts(contacts),
        missing_trns: findMissingTrns(contacts),
        duplicate_accounts: findDuplicateAccounts(accounts),
        unused_accounts: unused,
        unused_checked: candidates.length,
      };
      suspenseNudges = suspense.map((sr): Nudge => ({
        kind: "suspense_balance" as Nudge["kind"], severity: "attention",
        title: `${sr.account_name} — ${sr.balance.toFixed(2)} parked at month-end`,
        detail: sr.note, key: `hyg:suspense:${sr.account_id}:${month}`, ref: { account_id: sr.account_id, balance: sr.balance },
      }));
    } catch (err) {
      hygiene = { error: `Hygiene checks unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }

    // --- Item 4: bank reconciliation at period end, per bank account.
    const reconciliations = await reconcileForAccounts(supabase, z, companyId, null, start, end, today);

    // --- Item 10: lock status for the month (informational; the actions do the work).
    const lockBlockers: string[] = [];
    if (end >= today) lockBlockers.push(`the period ${month} has not ended yet`);
    for (const r of reconciliations) {
      if (r.status === "differs") lockBlockers.push(`${r.account.name}: statement and books differ by ${r.difference?.toFixed(2)}`);
      if (r.status === "pending") lockBlockers.push(`${r.account.name}: ${r.unposted_lines + r.uncategorised_in_zoho} line(s) still pending`);
      if (r.status === "no_statement" && r.unposted_lines > 0) lockBlockers.push(`${r.account.name}: ${r.unposted_lines} statement line(s) not yet posted`);
    }
    if (journalProposals.some((p) => (p as { status?: string }).status === "proposed")) lockBlockers.push(`${journalProposals.filter((p) => (p as { status?: string }).status === "proposed").length} journal proposal(s) still awaiting a decision`);
    const lock = { locked_until: lockedUntil, already_locked: Boolean(lockedUntil && lockedUntil >= end), ready: lockBlockers.length === 0, blockers: lockBlockers };

    const nudges: Nudge[] = [
      ...recurringJournalNudges(defs, posted, month),
      ...journalPatternNudges(enabledPatterns, postedWithFp, month),
      ...expectedBillNudges(enabled, seen, month, today),
      ...laterThanUsualNudges(enabledLtu, openDocs, today),
      ...(faNudge ? [faNudge as Nudge] : []),
      ...suspenseNudges,
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
      lock,
      ct,
      schedules,
      asset_proposals: assetProps ?? [],
      fixed_assets: { active_count: faAssetsCount, types: faTypes },
      hygiene,
      warnings: warnings.length ? warnings : undefined,
      usage: meter.summary(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("month-end failed:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
