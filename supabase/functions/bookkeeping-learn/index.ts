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
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
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

type DocKind = "bill" | "invoice" | "expense" | "journal";
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
};

interface LearnInput {
  company_id?: string;
  /** How far back to read; default 24. */
  months_back?: number;
  /** Cap on documents to detail-fetch per kind, for cost control. */
  max_docs_per_kind?: number;
  /** Re-analyse from bk_history_raw without touching Zoho. */
  reanalyze_only?: boolean;
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

function apiBase(): string {
  return Deno.env.get("ZOHO_API_BASE_URL")?.trim() ||
    "https://www.zohoapis.com/books/v3";
}
function orgId(): string {
  return requireEnv("ZOHO_ORGANIZATION_ID");
}

// ---------------------------------------------------------------------------
// OAuth: cached token first (Zoho throttles refresh hard), refresh on miss.
// ---------------------------------------------------------------------------
async function refreshAccessToken(supabase: SupabaseClient): Promise<string> {
  const accountsUrl = Deno.env.get("ZOHO_ACCOUNTS_URL")?.trim() ||
    "https://accounts.zoho.com";
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
    throw new Error(
      `Zoho token refresh failed (${res.status}): ${JSON.stringify(payload)}`,
    );
  }
  const token = String(payload.access_token);
  await supabase.from("zoho_oauth_tokens").upsert({
    id: 1,
    access_token: token,
    expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  return token;
}

async function getAccessToken(supabase: SupabaseClient): Promise<string> {
  const existing = Deno.env.get("ZOHO_ACCESS_TOKEN")?.trim();
  if (existing) return existing;
  const { data } = await supabase
    .from("zoho_oauth_tokens")
    .select("access_token, expires_at")
    .eq("id", 1)
    .maybeSingle();
  if (
    data?.access_token &&
    new Date(String(data.expires_at)).getTime() > Date.now() + 120_000
  ) {
    return String(data.access_token);
  }
  return await refreshAccessToken(supabase);
}

// ---------------------------------------------------------------------------
// Zoho fetch with gentle backoff on 429 / 5xx.
// ---------------------------------------------------------------------------
async function zohoGet(
  accessToken: string,
  path: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ organization_id: orgId(), ...params });
  const url = `${apiBase()}/${path}?${qs.toString()}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
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
  accessToken: string,
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
    const raw = await zohoGet(accessToken, path, {
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
      ? (Number(li.debit_amount ?? 0) || 0) - (Number(li.credit_amount ?? 0) || 0)
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
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let input: LearnInput = {};
  try {
    const text = await req.text();
    input = text ? (JSON.parse(text) as LearnInput) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const companyId = input.company_id ?? DEFAULT_COMPANY;
  const monthsBack = Math.max(1, Math.min(60, input.months_back ?? 24));
  const cap = Math.max(1, Math.min(2000, input.max_docs_per_kind ?? 500));
  const supabase = getSupabase();

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

    if (!input.reanalyze_only) {
      const token = await getAccessToken(supabase);
      const from = new Date();
      from.setMonth(from.getMonth() - monthsBack);
      const fromDate = from.toISOString().slice(0, 10);

      for (const kind of ["bill", "invoice", "expense", "journal"] as const) {
        const ids = await listIds(token, kind, fromDate, cap);
        const path = KIND_META[kind].path;
        // Skip ids we already have raw payloads for.
        const { data: have } = await supabase
          .from("bk_history_raw")
          .select("zoho_id")
          .eq("company_id", companyId)
          .eq("doc_kind", kind)
          .in("zoho_id", ids.length ? ids : ["-"]);
        const haveSet = new Set((have ?? []).map((r) => String(r.zoho_id)));

        for (const id of ids) {
          if (haveSet.has(id)) continue;
          const detail = await zohoGet(token, `${path}/${id}`);
          await supabase.from("bk_history_raw").upsert({
            company_id: companyId,
            doc_kind: kind,
            zoho_id: id,
            payload: detail,
          }, { onConflict: "company_id,doc_kind,zoho_id" });
          if (kind === "bill") billsFetched++;
          else if (kind === "invoice") invoicesFetched++;
          else if (kind === "expense") expensesFetched++;
          else journalsFetched++;
        }
      }
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

    if (runId) {
      await supabase.from("bk_learn_runs").update({
        status: "completed",
        bills_fetched: billsFetched,
        invoices_fetched: invoicesFetched,
        expenses_fetched: expensesFetched,
        journals_fetched: journalsFetched,
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
