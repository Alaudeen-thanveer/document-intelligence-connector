// Bookkeeping patterns learner (layer 1: party → account profiles).
// Reads a company's Zoho Books history once, stores raw payloads, and
// distils per-party profiles into bk_party_profiles as PROPOSALS.
//
// This function writes ONLY to bk_* tables. It never writes
// vendor_account_rules / customer_account_rules, never writes to Zoho, and
// never changes a document. Promotion to a real rule happens only when a
// human clicks Accept in the Rules screen.
//
// See docs/BOOKKEEPING_PATTERNS_SPEC.md.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createZohoMeter, meterContextFromRequest } from "../_shared/zoho_meter.ts";
import { isAuthFail, requireUser } from "../_shared/require_user.ts";

/** Set per request; every Zoho call goes through it so usage is metered. */
let zohoFetch: (url: string, init?: RequestInit) => Promise<Response> = fetch;
import {
  buildPartyProfiles,
  type HistoryDoc,
  isProposable,
  partyKindForDoc,
} from "./analyze.ts";
import { classifyRhythm, proposeChecks } from "./recurrence.ts";
import { learnAttachmentConvention } from "./attachments.ts";
import {
  learnJournalTagUsage,
  learnPartyTagProfiles,
  parseZohoLineTags,
} from "./tags_projects.ts";
import {
  buildTimingProfiles,
  isTimingProposable,
  type PaymentDoc,
  type TimingDoc,
} from "./timing.ts";
import {
  findJournalPatterns,
  isJournalPatternProposable,
  type JournalForPattern,
} from "./journal_patterns.ts";
import {
  type BankObservation,
  type BankSide,
  type BankTxnKind,
  buildBankPatterns,
} from "./bank_patterns.ts";
import { companyForCaller, isCompanyFail } from "../_shared/tenant.ts";
import { zohoAuthFor, type ZohoAuth } from "../_shared/zoho_auth.ts";

type DocKind =
  | "bill"
  | "invoice"
  | "expense"
  | "journal"
  | "vendorpayment"
  | "customerpayment";
const KIND_META: Record<
  DocKind,
  { path: string; listKey: string; idKey: string; rootKey: string }
> = {
  bill: { path: "bills", listKey: "bills", idKey: "bill_id", rootKey: "bill" },
  invoice: {
    path: "invoices",
    listKey: "invoices",
    idKey: "invoice_id",
    rootKey: "invoice",
  },
  expense: {
    path: "expenses",
    listKey: "expenses",
    idKey: "expense_id",
    rootKey: "expense",
  },
  journal: {
    path: "journals",
    listKey: "journals",
    idKey: "journal_id",
    rootKey: "journal",
  },
  vendorpayment: {
    path: "vendorpayments",
    listKey: "vendorpayments",
    idKey: "payment_id",
    rootKey: "vendorpayment",
  },
  customerpayment: {
    path: "customerpayments",
    listKey: "customerpayments",
    idKey: "payment_id",
    rootKey: "payment",
  },
};

interface LearnInput {
  company_id?: string;
  /** How far back to read; default 24. */
  months_back?: number;
  /** Cap on documents to detail-fetch per kind, for cost control. */
  max_docs_per_kind?: number;
  /** Re-analyse from bk_history_raw without touching Zoho. */
  reanalyze_only?: boolean;
  /**
   * Re-fetch already-cached bills and invoices so status / balance reflect
   * payments made since they were first cached. Timing (layer 6) depends
   * on this; cheap for small orgs, so it defaults ON for full runs.
   */
  refresh_documents?: boolean;
}

const CORS_HEADERS = corsHeaders("authorization, content-type, apikey, x-client-info");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function getSupabase(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}


// ---------------------------------------------------------------------------
// OAuth: cached z first (Zoho throttles refresh hard), refresh on miss.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Zoho fetch with gentle backoff on 429 / 5xx.
// ---------------------------------------------------------------------------
async function zohoGet(
  z: ZohoAuth,
  path: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ organization_id: z.organizationId, ...params });
  const url = `${z.apiBase}/${path}?${qs.toString()}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await zohoFetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` },
    });
    const raw = await res.json().catch(() => ({}));
    if (res.ok) return raw as Record<string, unknown>;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      continue;
    }
    throw new Error(
      `Zoho ${path} failed (${res.status}): ${JSON.stringify(raw)}`,
    );
  }
  throw new Error(`Zoho ${path}: retries exhausted`);
}

async function listIds(
  z: ZohoAuth,
  kind: DocKind,
  fromDate: string,
  cap: number,
): Promise<string[]> {
  const { path, listKey, idKey } = KIND_META[kind];
  const ids: string[] = [];
  let page = 1;
  while (ids.length < cap && page <= 50) {
    // Journals use journal_date for filtering/sorting; the others use date.
    const dateField = kind === "journal" ? "journal_date" : "date";
    const raw = await zohoGet(z, path, {
      per_page: "200",
      page: String(page),
      [`${dateField}_start`]: fromDate,
      sort_column: dateField,
      sort_order: "D",
    });
    const items = (raw[listKey] as Array<Record<string, unknown>>) ?? [];
    for (const it of items) {
      if (it[idKey] != null) ids.push(String(it[idKey]));
      if (ids.length >= cap) break;
    }
    const more = Boolean(
      (raw as { page_context?: { has_more_page?: boolean } }).page_context
        ?.has_more_page,
    );
    if (!more) break;
    page++;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Zoho payload → HistoryDoc.
// ---------------------------------------------------------------------------
function toHistoryDoc(
  kind: DocKind,
  raw: Record<string, unknown>,
): HistoryDoc | null {
  // Payments feed layer 6 and bank transactions feed bank layer 1; neither
  // is a party→account document.
  if (!KIND_META[kind]) return null;
  if (kind === "vendorpayment" || kind === "customerpayment") return null;
  const doc = (raw[KIND_META[kind].rootKey] ?? raw) as Record<string, unknown>;

  // Journals have no party; expenses and bills have a vendor; invoices a customer.
  const partyId = kind === "journal"
    ? ""
    : kind === "invoice"
    ? doc.customer_id
    : doc.vendor_id;
  const partyName = kind === "journal"
    ? ""
    : kind === "invoice"
    ? doc.customer_name
    : doc.vendor_name;
  if (kind !== "journal" && partyId == null) return null;

  const rawLines = (doc.line_items as Array<Record<string, unknown>>) ?? [];
  // Expenses are flat (one account, one amount) with header-level tags/project.
  const lineSource = kind === "expense" && rawLines.length === 0
    ? [{
      account_id: doc.account_id,
      account_name: doc.account_name,
      amount: doc.total ?? doc.amount,
      tags: doc.tags,
      project_id: doc.project_id,
      project_name: doc.project_name,
    }]
    : rawLines;

  const lines = lineSource.map((li) => ({
    account_id: li.account_id != null ? String(li.account_id) : null,
    account_name: li.account_name != null ? String(li.account_name) : null,
    // Journals: signed by debit/credit so both sides are visible.
    amount: kind === "journal"
      ? ((Number(li.debit_amount ?? 0) ||
          (String(li.debit_or_credit ?? "").toLowerCase() === "debit"
            ? Number(li.amount ?? 0) || 0
            : 0)) -
        (Number(li.credit_amount ?? 0) ||
          (String(li.debit_or_credit ?? "").toLowerCase() === "credit"
            ? Number(li.amount ?? 0) || 0
            : 0)))
      : Number(li.item_total ?? li.amount ?? 0) || 0,
    tags: parseZohoLineTags(li.tags),
    project_id: li.project_id != null && String(li.project_id) !== ""
      ? String(li.project_id)
      : null,
    project_name: li.project_name != null ? String(li.project_name) : null,
  }));

  const hasPo = Boolean(
    (kind === "bill" &&
      (doc.purchaseorder_ids as unknown[] | undefined)?.length) ||
      String(doc.reference_number ?? "").trim(),
  );

  return {
    doc_kind: kind,
    zoho_id: String(doc[KIND_META[kind].idKey] ?? ""),
    party_zoho_id: String(partyId ?? ""),
    party_name: String(partyName ?? ""),
    date: String(doc.date ?? doc.journal_date ?? "").slice(0, 10),
    total: Number(doc.total ?? doc.amount ?? 0) || 0,
    currency: doc.currency_code != null ? String(doc.currency_code) : null,
    tax_treatment: doc.tax_treatment ? String(doc.tax_treatment) : null,
    payment_terms_id: doc.payment_terms_id != null
      ? String(doc.payment_terms_id)
      : null,
    has_po: hasPo,
    line_items: lines,
    documents: ((doc.documents as Array<Record<string, unknown>>) ?? []).map(
      (d) => ({
        file_name: d.file_name != null ? String(d.file_name) : null,
        file_type: d.file_type != null ? String(d.file_type) : null,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Bank transactions (bank layer 1).
// ---------------------------------------------------------------------------

/** Zoho transaction_type → the kind we learn. */
function bankTxnKind(t: string): BankTxnKind {
  const s = t.toLowerCase();
  if (s === "customer_payment") return "customer_payment";
  if (s === "vendor_payment") return "vendor_payment";
  if (s.includes("transfer")) return "transfer";
  if (
    s === "expense" || s === "card_payment" || s === "expense_refund" ||
    s.includes("charge") || s.includes("tax")
  ) return "expense";
  if (
    s === "deposit" || s === "sales_without_invoices" || s === "interest_income" ||
    s === "other_income" || s === "owner_contribution" || s === "refund"
  ) return "deposit";
  return "other";
}

/**
 * List categorised transactions on every bank/cash account and cache the
 * rows. Zoho keeps payment-type rows under the payments endpoints (their
 * detail 404s here), so only expense/deposit/transfer kinds are detail-
 * fetched, and only to learn the category account id.
 */
async function fetchBankTransactions(
  supabase: SupabaseClient,
  z: ZohoAuth,
  companyId: string,
  fromDate: string,
  cap: number,
): Promise<number> {
  const accts = await zohoGet(z, "bankaccounts");
  const accounts = ((accts.bankaccounts as Array<Record<string, unknown>>) ?? [])
    .filter((a) => a.account_id != null);
  let fetched = 0;
  for (const a of accounts) {
    const accountId = String(a.account_id);
    let page = 1;
    let count = 0;
    while (count < cap && page <= 25) {
      let raw: Record<string, unknown>;
      try {
        raw = await zohoGet(z, "banktransactions", {
          account_id: accountId,
          date_start: fromDate,
          per_page: "200",
          page: String(page),
          sort_column: "date",
          sort_order: "D",
        });
      } catch {
        // Some orgs reject the date filter here; fall back to unfiltered.
        raw = await zohoGet(z, "banktransactions", {
          account_id: accountId,
          per_page: "200",
          page: String(page),
        });
      }
      const rows = (raw.banktransactions as Array<Record<string, unknown>>) ?? [];
      for (const row of rows) {
        const id = String(row.transaction_id ?? "");
        if (!id) continue;
        // Uncategorised feed lines teach nothing yet.
        const status = String(row.status ?? "").toLowerCase();
        if (status === "uncategorized") continue;
        const { data: have } = await supabase
          .from("bk_history_raw")
          .select("zoho_id")
          .eq("company_id", companyId)
          .eq("doc_kind", "banktransaction")
          .eq("zoho_id", id)
          .maybeSingle();
        if (have) { count++; continue; }

        const kind = bankTxnKind(String(row.transaction_type ?? ""));
        let payload: Record<string, unknown> = { banktransaction: row };
        if (kind !== "customer_payment" && kind !== "vendor_payment") {
          try {
            const detail = await zohoGet(z, `banktransactions/${id}`);
            if (detail.banktransaction) {
              payload = {
                banktransaction: {
                  ...row,
                  ...(detail.banktransaction as Record<string, unknown>),
                },
              };
            }
          } catch {
            // list row is enough; category id resolves by name later
          }
        }
        await supabase.from("bk_history_raw").upsert({
          company_id: companyId,
          doc_kind: "banktransaction",
          zoho_id: id,
          payload,
        }, { onConflict: "company_id,doc_kind,zoho_id" });
        fetched++;
        count++;
        if (count >= cap) break;
      }
      const more = Boolean(
        (raw as { page_context?: { has_more_page?: boolean } }).page_context
          ?.has_more_page,
      );
      if (!more) break;
      page++;
    }
  }
  return fetched;
}

/**
 * Turn cached history into bank observations. Three sources:
 *   • categorised bank transactions (description, payee, category account)
 *   • customer / vendor payments (description + reference, party, deposit
 *     or paid-through account)
 *   • lines a reviewer confirmed in this app (added in bank layer 4)
 * accountByName resolves a category shown only by name on list rows.
 */
function bankObservationsFromHistory(
  rawRows: Array<{ doc_kind: string; payload: unknown }>,
  accountByName: Map<string, string>,
): BankObservation[] {
  const out: BankObservation[] = [];
  for (const r of rawRows) {
    const p = r.payload as Record<string, unknown>;
    if (r.doc_kind === "banktransaction") {
      const t = (p.banktransaction ?? p) as Record<string, unknown>;
      // First non-empty of description / reference / payee — feeds often
      // leave description blank and put the counterparty in payee.
      const description = [t.description, t.reference_number, t.payee]
        .map((x) => (x == null ? "" : String(x).trim()))
        .find(Boolean) ?? "";
      if (!description) continue;
      // Zoho's debit_or_credit is the LEDGER view (money out of the bank =
      // credit to the bank account); our side is the statement view.
      const side: BankSide = String(t.debit_or_credit ?? "").toLowerCase() === "credit"
        ? "debit"
        : "credit";
      const kind = bankTxnKind(String(t.transaction_type ?? ""));
      const isPayment = kind === "customer_payment" || kind === "vendor_payment";
      // Category account: from detail line_items, else by offset name.
      const li = ((t.line_items as Array<Record<string, unknown>>) ?? [])[0];
      const offsetName = t.offset_account_name != null ? String(t.offset_account_name) : null;
      const accountId = li?.account_id != null
        ? String(li.account_id)
        : offsetName && accountByName.has(offsetName.toLowerCase())
        ? accountByName.get(offsetName.toLowerCase())!
        : null;
      const partyId = t.customer_id != null && String(t.customer_id) !== ""
        ? String(t.customer_id)
        : t.vendor_id != null && String(t.vendor_id) !== ""
        ? String(t.vendor_id)
        : null;
      out.push({
        description,
        side,
        amount: Number(t.amount ?? 0) || 0,
        date: String(t.date ?? "").slice(0, 10),
        txn_kind: kind,
        party_kind: partyId
          ? (kind === "vendor_payment" || (kind === "expense" && side === "debit") ? "vendor" : "customer")
          : null,
        party_zoho_id: partyId,
        party_name: t.payee != null && String(t.payee) !== "" ? String(t.payee) : null,
        account_id: isPayment ? null : accountId,
        account_name: isPayment ? null : (li?.account_name != null ? String(li.account_name) : offsetName),
        source: "zoho_bank",
      });
    } else if (r.doc_kind === "customerpayment" || r.doc_kind === "vendorpayment") {
      const root = r.doc_kind === "customerpayment" ? "payment" : "vendorpayment";
      const d = (p[root] ?? p) as Record<string, unknown>;
      const description = [d.description, d.reference_number]
        .map((x) => (x == null ? "" : String(x).trim()))
        .filter(Boolean)
        .join(" ");
      if (!description) continue;
      const isCustomer = r.doc_kind === "customerpayment";
      out.push({
        description,
        side: isCustomer ? "credit" : "debit",
        amount: Number(d.amount ?? 0) || 0,
        date: String(d.date ?? "").slice(0, 10),
        txn_kind: isCustomer ? "customer_payment" : "vendor_payment",
        party_kind: isCustomer ? "customer" : "vendor",
        party_zoho_id: String((isCustomer ? d.customer_id : d.vendor_id) ?? "") || null,
        party_name: String((isCustomer ? d.customer_name : d.vendor_name) ?? "") || null,
        account_id: null,
        account_name: null,
        source: "zoho_payment",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const auth = await requireUser(req, { corsHeaders: CORS_HEADERS });
  if (isAuthFail(auth)) return auth.response;

  let input: LearnInput = {};
  try {
    const text = await req.text();
    input = text ? (JSON.parse(text) as LearnInput) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  // Runs with the service role, so nothing below checks who is asking
  // unless this does. No default company: a fallback is how a bug
  // becomes a cross-client leak instead of an error.
  const tenant = await companyForCaller(auth, {
    companyId: input.company_id ?? null,
    errorBody: (m) => ({ error: m }),
  });
  if (isCompanyFail(tenant)) return tenant.response;
  const companyId = tenant.companyId;
  const monthsBack = Math.max(1, Math.min(60, input.months_back ?? 24));
  const cap = Math.max(1, Math.min(2000, input.max_docs_per_kind ?? 500));
  const supabase = getSupabase();
  const meter = createZohoMeter(supabase, {
    ...meterContextFromRequest(req, "learn", "bookkeeping-learn"),
    company_id: companyId,
  });
  zohoFetch = meter.fetch;

  const { data: run } = await supabase
    .from("bk_learn_runs")
    .insert({ company_id: companyId, months_back: monthsBack })
    .select("id")
    .single();
  const runId = run?.id as string | undefined;

  try {
    let billsFetched = 0;
    let invoicesFetched = 0;
    let expensesFetched = 0;
    let journalsFetched = 0;
    let paymentsFetched = 0;
    let bankTransactionsFetched = 0;

    if (!input.reanalyze_only) {
      const z = await getAccessToken(supabase, companyId);
      const from = new Date();
      from.setMonth(from.getMonth() - monthsBack);
      const fromDate = from.toISOString().slice(0, 10);

      for (
        const kind of [
          "bill",
          "invoice",
          "expense",
          "journal",
          "vendorpayment",
          "customerpayment",
        ] as const
      ) {
        const ids = await listIds(z, kind, fromDate, cap);
        const path = KIND_META[kind].path;
        // Skip ids we already have raw payloads for.
        const { data: have } = await supabase
          .from("bk_history_raw")
          .select("zoho_id")
          .eq("company_id", companyId)
          .eq("doc_kind", kind)
          .in("zoho_id", ids.length ? ids : ["-"]);
        const haveSet = new Set((have ?? []).map((r) => String(r.zoho_id)));
        // Bills/invoices change after caching (payments alter status and
        // balance), so re-fetch them unless the caller opted out. Payments,
        // expenses and journals are immutable enough to keep.
        const refresh = (input.refresh_documents ?? true) &&
          (kind === "bill" || kind === "invoice");

        for (const id of ids) {
          if (haveSet.has(id) && !refresh) continue;
          const detail = await zohoGet(z, `${path}/${id}`);
          await supabase.from("bk_history_raw").upsert({
            company_id: companyId,
            doc_kind: kind,
            zoho_id: id,
            payload: detail,
          }, { onConflict: "company_id,doc_kind,zoho_id" });
          if (kind === "bill") billsFetched++;
          else if (kind === "invoice") invoicesFetched++;
          else if (kind === "expense") expensesFetched++;
          else if (kind === "journal") journalsFetched++;
          else paymentsFetched++;
        }
      }

      // Bank transactions are listed per bank account, not by date range
      // across the org, so they get their own pass. The list row already
      // carries what we learn from (description, payee, side, category as
      // offset_account_name); detail is fetched only for non-payment kinds
      // to resolve the category account's id, and only when unseen.
      bankTransactionsFetched = await fetchBankTransactions(
        supabase, z, companyId, fromDate, cap,
      );
    }

    // Analyse everything we hold for this company.
    const { data: rawRows } = await supabase
      .from("bk_history_raw")
      .select("doc_kind, payload")
      .eq("company_id", companyId);
    const docs: HistoryDoc[] = [];
    for (const r of rawRows ?? []) {
      const d = toHistoryDoc(
        r.doc_kind as DocKind,
        r.payload as Record<string, unknown>,
      );
      if (d) docs.push(d);
    }

    const profiles = buildPartyProfiles(docs);

    // Upsert profiles. Preserve a human decision already recorded on a
    // party: a recomputed profile never flips accepted/dismissed back to
    // proposed. (Stale marking on drift is layer-2 work.)
    let written = 0;
    for (const p of profiles) {
      const { data: existing } = await supabase
        .from("bk_party_profiles")
        .select("suggestion_status")
        .eq("company_id", companyId)
        .eq("party_kind", p.party_kind)
        .eq("party_zoho_id", p.party_zoho_id)
        .maybeSingle();
      const keepStatus = existing?.suggestion_status &&
          existing.suggestion_status !== "proposed"
        ? existing.suggestion_status
        : "proposed";
      const { error } = await supabase.from("bk_party_profiles").upsert({
        company_id: companyId,
        ...p,
        suggestion_status: keepStatus,
        computed_at: new Date().toISOString(),
      }, { onConflict: "company_id,party_kind,party_zoho_id" });
      if (!error) written++;
    }

    // Layer 2: recurrence per party → bk_rhythms + proposed checks.
    // Checks are proposals: the judgment engine never reads them until a
    // human sets status = 'enabled'. Recompute preserves human decisions.
    const byParty = new Map<string, HistoryDoc[]>();
    for (const d of docs) {
      const kind = partyKindForDoc(d.doc_kind);
      if (!kind || !d.party_zoho_id) continue; // journals have no party
      const key = `${kind}:${d.party_zoho_id}`;
      const list = byParty.get(key) ?? [];
      list.push(d);
      byParty.set(key, list);
    }
    let rhythmsWritten = 0;
    let checksProposed = 0;
    let attachmentsWritten = 0;
    const cadenceSummary: Record<string, number> = {};
    for (const [key, list] of byParty) {
      const party_kind = key.startsWith("vendor:") ? "vendor" : "customer";
      const rhythm = classifyRhythm(
        list.map((d) => ({ date: d.date, total: d.total })),
      );
      cadenceSummary[rhythm.cadence] = (cadenceSummary[rhythm.cadence] ?? 0) + 1;
      const partyName = list[0].party_name;
      const { error: rErr } = await supabase.from("bk_rhythms").upsert({
        company_id: companyId,
        party_kind,
        party_zoho_id: list[0].party_zoho_id,
        party_name: partyName,
        ...rhythm,
        computed_at: new Date().toISOString(),
      }, { onConflict: "company_id,party_kind,party_zoho_id" });
      if (!rErr) rhythmsWritten++;

      // Layer 3: attachment convention (bills only — invoices are outbound).
      if (party_kind === "vendor") {
        const conv = learnAttachmentConvention(
          list.map((d) => ({ documents: d.documents ?? [] })),
        );
        await supabase.from("bk_attachment_conventions").upsert({
          company_id: companyId,
          party_kind,
          party_zoho_id: list[0].party_zoho_id,
          party_name: partyName,
          ...conv,
          computed_at: new Date().toISOString(),
        }, { onConflict: "company_id,party_kind,party_zoho_id" });
        attachmentsWritten++;
        // Only propose when there is enough history to say something.
        if (conv.sample_size >= 3 && conv.proposed_strictness !== "standard") {
          const { data: existing } = await supabase
            .from("bk_check_proposals")
            .select("status")
            .eq("company_id", companyId)
            .eq("party_kind", party_kind)
            .eq("party_zoho_id", list[0].party_zoho_id)
            .eq("check_kind", "supporting_document_strictness")
            .maybeSingle();
          const keep = existing?.status && existing.status !== "proposed"
            ? existing.status
            : "proposed";
          const { error: aErr } = await supabase.from("bk_check_proposals")
            .upsert({
              company_id: companyId,
              party_kind,
              party_zoho_id: list[0].party_zoho_id,
              party_name: partyName,
              check_kind: "supporting_document_strictness",
              rationale: conv.rationale,
              params: {
                strictness: conv.proposed_strictness,
                count_mode: conv.count_mode,
                recurring_name_tokens: conv.recurring_name_tokens,
              },
              status: keep,
              computed_at: new Date().toISOString(),
            }, {
              onConflict: "company_id,party_kind,party_zoho_id,check_kind",
            });
          if (!aErr) checksProposed++;
        }
      }

      for (const c of proposeChecks(rhythm)) {
        const { data: existing } = await supabase
          .from("bk_check_proposals")
          .select("status")
          .eq("company_id", companyId)
          .eq("party_kind", party_kind)
          .eq("party_zoho_id", list[0].party_zoho_id)
          .eq("check_kind", c.check_kind)
          .maybeSingle();
        const keep = existing?.status && existing.status !== "proposed"
          ? existing.status
          : "proposed";
        const { error: cErr } = await supabase.from("bk_check_proposals")
          .upsert({
            company_id: companyId,
            party_kind,
            party_zoho_id: list[0].party_zoho_id,
            party_name: partyName,
            check_kind: c.check_kind,
            rationale: c.rationale,
            params: c.params,
            status: keep,
            computed_at: new Date().toISOString(),
          }, { onConflict: "company_id,party_kind,party_zoho_id,check_kind" });
        if (!cErr) checksProposed++;
      }
    }

    // Layer 4: reporting tags + projects per party (bills, invoices,
    // expenses) and per account (journals). Proposals only; recompute
    // preserves human decisions.
    let tagProfilesWritten = 0;
    let projectProfilesWritten = 0;
    let accountTagProfilesWritten = 0;
    const keepDecision = async (
      table: string,
      match: Record<string, string>,
    ): Promise<string> => {
      let q = supabase.from(table).select("suggestion_status").eq(
        "company_id",
        companyId,
      );
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
      const { data } = await q.maybeSingle();
      return data?.suggestion_status && data.suggestion_status !== "proposed"
        ? String(data.suggestion_status)
        : "proposed";
    };

    for (const tp of learnPartyTagProfiles(docs)) {
      for (const t of tp.tags) {
        const status = await keepDecision("bk_party_tag_profiles", {
          party_kind: tp.party_kind,
          party_zoho_id: tp.party_zoho_id,
          tag_id: t.tag_id,
        });
        const { error } = await supabase.from("bk_party_tag_profiles").upsert({
          company_id: companyId,
          party_kind: tp.party_kind,
          party_zoho_id: tp.party_zoho_id,
          party_name: tp.party_name,
          tag_id: t.tag_id,
          tag_name: t.tag_name,
          option_id: t.option_id,
          option_name: t.option_name,
          share: t.share,
          lines: t.lines,
          confidence: t.confidence,
          suggestion_status: status,
          computed_at: new Date().toISOString(),
        }, { onConflict: "company_id,party_kind,party_zoho_id,tag_id" });
        if (!error) tagProfilesWritten++;
      }
      if (tp.project) {
        const status = await keepDecision("bk_party_project_profiles", {
          party_kind: tp.party_kind,
          party_zoho_id: tp.party_zoho_id,
        });
        const { error } = await supabase.from("bk_party_project_profiles")
          .upsert({
            company_id: companyId,
            party_kind: tp.party_kind,
            party_zoho_id: tp.party_zoho_id,
            party_name: tp.party_name,
            project_id: tp.project.project_id,
            project_name: tp.project.project_name,
            share: tp.project.share,
            lines: tp.project.lines,
            confidence: tp.project.confidence,
            suggestion_status: status,
            computed_at: new Date().toISOString(),
          }, { onConflict: "company_id,party_kind,party_zoho_id" });
        if (!error) projectProfilesWritten++;
      }
    }
    for (const u of learnJournalTagUsage(docs)) {
      const status = await keepDecision("bk_account_tag_profiles", {
        account_id: u.account_id,
        tag_id: u.tag_id,
      });
      const { error } = await supabase.from("bk_account_tag_profiles").upsert({
        company_id: companyId,
        account_id: u.account_id,
        account_name: u.account_name,
        tag_id: u.tag_id,
        tag_name: u.tag_name,
        option_id: u.option_id,
        option_name: u.option_name,
        share: u.share,
        lines: u.lines,
        confidence: u.confidence,
        suggestion_status: status,
        computed_at: new Date().toISOString(),
      }, { onConflict: "company_id,account_id,tag_id" });
      if (!error) accountTagProfilesWritten++;
    }

    // ------------------------------------------------------------------
    // Layer 6: timing / payment behaviour. Needs the raw bill/invoice
    // payloads (created_time, balance, status, due_date, payment terms) and
    // the payment payloads (dates + which documents each settled).
    // ------------------------------------------------------------------
    const timingDocs: TimingDoc[] = [];
    const paymentDocs: PaymentDoc[] = [];
    const journalsForPatterns: JournalForPattern[] = [];
    for (const r of rawRows ?? []) {
      const kind = r.doc_kind as DocKind;
      const root = KIND_META[kind]?.rootKey;
      const doc = ((r.payload as Record<string, unknown>)[root] ??
        r.payload) as Record<string, unknown>;

      if (kind === "bill" || kind === "invoice") {
        const partyId = kind === "bill" ? doc.vendor_id : doc.customer_id;
        if (partyId == null) continue;
        const termsRaw = doc.payment_terms;
        const created = String(doc.created_time ?? "").slice(0, 10);
        timingDocs.push({
          doc_kind: kind,
          zoho_id: String(doc[KIND_META[kind].idKey] ?? ""),
          party_zoho_id: String(partyId),
          party_name: String((kind === "bill" ? doc.vendor_name : doc.customer_name) ?? ""),
          date: String(doc.date ?? "").slice(0, 10),
          entered_date: /^\d{4}-\d{2}-\d{2}$/.test(created) ? created : null,
          due_date: doc.due_date ? String(doc.due_date).slice(0, 10) : null,
          terms_days: termsRaw != null && Number.isFinite(Number(termsRaw))
            ? Number(termsRaw)
            : null,
          total: Number(doc.total ?? 0) || 0,
          balance: Number(doc.balance ?? 0) || 0,
          status: String(doc.status ?? ""),
        });
      } else if (kind === "vendorpayment" || kind === "customerpayment") {
        const partyId = kind === "vendorpayment" ? doc.vendor_id : doc.customer_id;
        const applied = ((kind === "vendorpayment" ? doc.bills : doc.invoices) as
          | Array<Record<string, unknown>>
          | undefined) ?? [];
        paymentDocs.push({
          payment_id: String(doc.payment_id ?? ""),
          party_zoho_id: String(partyId ?? ""),
          date: String(doc.date ?? "").slice(0, 10),
          amount: Number(doc.amount ?? 0) || 0,
          payment_mode: doc.payment_mode != null ? String(doc.payment_mode) : null,
          // Vendor payments: paid_through_account_*; customer payments:
          // account_* (the deposit-to account).
          account_id: (doc.paid_through_account_id ?? doc.account_id) != null
            ? String(doc.paid_through_account_id ?? doc.account_id)
            : null,
          account_name: (doc.paid_through_account_name ?? doc.account_name) != null
            ? String(doc.paid_through_account_name ?? doc.account_name)
            : null,
          applied: applied.map((a) => ({
            doc_zoho_id: String(
              (kind === "vendorpayment" ? a.bill_id : a.invoice_id) ?? "",
            ),
            amount: Number(a.amount_applied ?? a.amount ?? 0) || 0,
          })).filter((a) => a.doc_zoho_id),
        });
      } else if (kind === "journal") {
        // Zoho journal lines carry `amount` + `debit_or_credit`; some
        // payloads use debit_amount / credit_amount. Handle both.
        const lines = ((doc.line_items as Array<Record<string, unknown>>) ?? [])
          .map((li) => {
            const side = String(li.debit_or_credit ?? "").toLowerCase();
            const amt = Number(li.amount ?? 0) || 0;
            return {
              account_id: String(li.account_id ?? ""),
              account_name: li.account_name != null ? String(li.account_name) : null,
              debit: Number(li.debit_amount ?? 0) || (side === "debit" ? amt : 0),
              credit: Number(li.credit_amount ?? 0) || (side === "credit" ? amt : 0),
            };
          });
        journalsForPatterns.push({
          journal_id: String(doc.journal_id ?? ""),
          date: String(doc.journal_date ?? doc.date ?? "").slice(0, 10),
          reference_number: doc.reference_number != null ? String(doc.reference_number) : null,
          notes: doc.notes != null ? String(doc.notes) : null,
          total: Number(doc.total ?? 0) || 0,
          // Zoho marks journals generated from a recurring definition.
          from_recurring: Boolean(doc.recurring_journal_id) ||
            String(doc.journal_type ?? "").toLowerCase().includes("recurring"),
          lines,
        });
      }
    }

    let timingWritten = 0;
    let laterThanUsualProposed = 0;
    for (const t of buildTimingProfiles(timingDocs, paymentDocs)) {
      const { error } = await supabase.from("bk_timing_profiles").upsert({
        company_id: companyId,
        ...t,
        computed_at: new Date().toISOString(),
      }, { onConflict: "company_id,party_kind,party_zoho_id" });
      if (!error) timingWritten++;
      // Propose a month-end "later than usual" watch for parties with
      // enough paid history to know what usual is.
      if (isTimingProposable(t) && t.pay_lag_p90 != null) {
        const { data: existing } = await supabase
          .from("bk_check_proposals")
          .select("status")
          .eq("company_id", companyId)
          .eq("party_kind", t.party_kind)
          .eq("party_zoho_id", t.party_zoho_id)
          .eq("check_kind", "later_than_usual")
          .maybeSingle();
        const keep = existing?.status && existing.status !== "proposed"
          ? existing.status
          : "proposed";
        const vsTerms = t.pays_vs_terms_days;
        const { error: cErr } = await supabase.from("bk_check_proposals").upsert({
          company_id: companyId,
          party_kind: t.party_kind,
          party_zoho_id: t.party_zoho_id,
          party_name: t.party_name,
          check_kind: "later_than_usual",
          rationale:
            `usually settled in ~${t.pay_lag_median} days (p90 ${t.pay_lag_p90})` +
            (vsTerms != null
              ? `, i.e. ${Math.abs(vsTerms)} days ${vsTerms > 0 ? "after" : "before"} the ${t.terms_days_mode}-day terms`
              : "") +
            `; nudge at month-end when an open document is older than that.`,
          params: {
            pay_lag_median: t.pay_lag_median,
            pay_lag_p90: t.pay_lag_p90,
            terms_days: t.terms_days_mode,
          },
          status: keep,
          computed_at: new Date().toISOString(),
        }, { onConflict: "company_id,party_kind,party_zoho_id,check_kind" });
        if (!cErr) laterThanUsualProposed++;
      }
    }

    // ------------------------------------------------------------------
    // Layer 5: repeating MANUAL journals (undeclared recurring journals).
    // ------------------------------------------------------------------
    let journalPatternsWritten = 0;
    let journalPatternsProposable = 0;
    for (const jp of findJournalPatterns(journalsForPatterns)) {
      const { data: existing } = await supabase
        .from("bk_journal_patterns")
        .select("status")
        .eq("company_id", companyId)
        .eq("fingerprint", jp.fingerprint)
        .maybeSingle();
      const keep = existing?.status && existing.status !== "proposed"
        ? existing.status
        : "proposed";
      const { error } = await supabase.from("bk_journal_patterns").upsert({
        company_id: companyId,
        ...jp,
        status: keep,
        computed_at: new Date().toISOString(),
      }, { onConflict: "company_id,fingerprint" });
      if (!error) journalPatternsWritten++;
      if (isJournalPatternProposable(jp)) journalPatternsProposable++;
    }

    // ------------------------------------------------------------------
    // Bank layer 1: statement description → party / account / kind.
    // Sources: cached bank transactions + payments, plus every statement
    // line a reviewer has confirmed in this app (bank layer 4 writes them).
    // Human decisions on a pattern survive recompute, as everywhere else.
    // ------------------------------------------------------------------
    const { data: acctRows } = await supabase
      .from("zoho_entities")
      .select("zoho_id, name")
      .eq("kind", "account");
    const accountByName = new Map<string, string>();
    for (const a of acctRows ?? []) accountByName.set(String(a.name).toLowerCase(), String(a.zoho_id));

    const bankObs = bankObservationsFromHistory(rawRows ?? [], accountByName);
    // Confirmed lines (table exists from bank layer 2 onward; tolerate absence).
    const { data: confirmed } = await supabase
      .from("bank_statement_lines")
      .select("description, side, amount, txn_date, chosen_txn_kind, chosen_party_kind, chosen_party_zoho_id, chosen_party_name, chosen_account_id, chosen_account_name")
      .eq("company_id", companyId)
      .in("status", ["confirmed", "posted"]);
    for (const c of confirmed ?? []) {
      if (!c.chosen_txn_kind) continue;
      // A link to an already-recorded entry says nothing about what the
      // description usually IS; an explicit exclude does, and is learned.
      if (c.chosen_txn_kind === "already_recorded") continue;
      bankObs.push({
        description: String(c.description ?? ""),
        side: c.side as BankSide,
        amount: Number(c.amount ?? 0) || 0,
        date: String(c.txn_date ?? "").slice(0, 10),
        txn_kind: c.chosen_txn_kind as BankTxnKind,
        party_kind: (c.chosen_party_kind as "vendor" | "customer" | null) ?? null,
        party_zoho_id: c.chosen_party_zoho_id ? String(c.chosen_party_zoho_id) : null,
        party_name: c.chosen_party_name ? String(c.chosen_party_name) : null,
        account_id: c.chosen_account_id ? String(c.chosen_account_id) : null,
        account_name: c.chosen_account_name ? String(c.chosen_account_name) : null,
        source: "confirmed_line",
      });
    }

    let bankPatternsWritten = 0;
    const bankPatterns = buildBankPatterns(bankObs);
    for (const bp of bankPatterns) {
      const { data: existing } = await supabase
        .from("bk_bank_patterns")
        .select("suggestion_status")
        .eq("company_id", companyId)
        .eq("fingerprint", bp.fingerprint)
        .eq("side", bp.side)
        .maybeSingle();
      const keep = existing?.suggestion_status && existing.suggestion_status !== "proposed"
        ? existing.suggestion_status
        : "proposed";
      const { error } = await supabase.from("bk_bank_patterns").upsert({
        company_id: companyId,
        ...bp,
        first_seen: bp.first_seen || null,
        last_seen: bp.last_seen || null,
        suggestion_status: keep,
        computed_at: new Date().toISOString(),
      }, { onConflict: "company_id,fingerprint,side" });
      if (!error) bankPatternsWritten++;
    }

    if (runId) {
      await supabase.from("bk_learn_runs").update({
        status: "completed",
        bills_fetched: billsFetched,
        invoices_fetched: invoicesFetched,
        expenses_fetched: expensesFetched,
        journals_fetched: journalsFetched,
        payments_fetched: paymentsFetched,
        bank_transactions_fetched: bankTransactionsFetched,
        profiles_written: written,
        finished_at: new Date().toISOString(),
      }).eq("id", runId);
    }

    return jsonResponse({
      ok: true,
      run_id: runId,
      company_id: companyId,
      months_back: monthsBack,
      bills_fetched: billsFetched,
      invoices_fetched: invoicesFetched,
      expenses_fetched: expensesFetched,
      journals_fetched: journalsFetched,
      documents_analyzed: docs.length,
      tag_profiles_written: tagProfilesWritten,
      project_profiles_written: projectProfilesWritten,
      account_tag_profiles_written: accountTagProfilesWritten,
      payments_fetched: paymentsFetched,
      timing_profiles_written: timingWritten,
      later_than_usual_proposed: laterThanUsualProposed,
      journal_patterns_written: journalPatternsWritten,
      journal_patterns_proposable: journalPatternsProposable,
      bank_transactions_fetched: bankTransactionsFetched,
      bank_observations: bankObs.length,
      bank_patterns_written: bankPatternsWritten,
      bank_patterns_suggestible: bankPatterns.filter((p) => p.confidence >= 0.55).length,
      usage: meter.summary(),
      profiles_written: written,
      proposable: profiles.filter(isProposable).length,
      rhythms_written: rhythmsWritten,
      cadences: cadenceSummary,
      attachment_conventions_written: attachmentsWritten,
      checks_proposed: checksProposed,
      profiles: profiles.map((p) => ({
        party_kind: p.party_kind,
        party_name: p.party_name,
        dominant_account_name: p.dominant_account_name,
        account_share: p.account_share,
        sample_size: p.sample_size,
        confidence: p.confidence,
        proposable: isProposable(p),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("bookkeeping-learn failed:", message);
    if (runId) {
      await supabase.from("bk_learn_runs").update({
        status: "failed",
        error: message,
        finished_at: new Date().toISOString(),
      }).eq("id", runId);
    }
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
