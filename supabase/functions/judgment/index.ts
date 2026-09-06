/**
 * Run the three hardcoded judgment checks for a document — plus any
 * per-vendor checks a human has ENABLED in bk_check_proposals — and store
 * each result in judgment_results. Not a pluggable rules engine.
 *
 * Learned checks: only rows with status = 'enabled' are ever consulted.
 * Proposed / dismissed / stale rows have no effect. The vendor is matched
 * from extracted vendor_raw to a synced Zoho vendor by normalized name.
 *
 * Input: { document_id: string }
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { matchPurchaseOrder, type PurchaseOrder, type PoMatchResult } from "./po_match.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  checkAmountAboveThresholdNoPo,
  checkDuplicate,
  checkMissingSupportingDocument,
  JUDGMENT_CHECK_NAMES,
  type CheckResult,
  type JudgmentCheckContext,
} from "./checks.ts";
import {
  applySupportingDocumentStrictness,
  checkAmountAnomaly,
  checkRecurringTwiceInPeriod,
  type EnabledCheck,
  LEARNED_RULE_NAMES,
  type PeerDoc,
} from "./learned_checks.ts";
import { isAuthFail, requireAuth } from "../_shared/require_user.ts";
import { companyForCaller, isCompanyFail } from "../_shared/tenant.ts";

// No default company. A document without one is a broken record, not a
// reason to act on somebody else's books.
const DEFAULT_DUPLICATE_DAYS = 3;
const DEFAULT_AMOUNT_PO_THRESHOLD = 5000;

interface JudgmentInput {
  document_id: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function getSupabase(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDateOnly(value: unknown): string | null {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

async function loadContext(
  supabase: SupabaseClient,
  documentId: string,
): Promise<JudgmentCheckContext> {
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("id, company_id, has_supporting_document")
    .eq("id", documentId)
    .single();

  if (docError || !doc) {
    throw new Error(`Document not found: ${docError?.message ?? documentId}`);
  }

  const { data: extracted, error: extError } = await supabase
    .from("extracted_fields")
    .select("id, vendor_raw, total_amount, invoice_date, po_number, tax_amount")
    .eq("document_id", documentId)
    // the current extraction: newest first, id only as the tiebreak
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (extError) {
    throw new Error(`Failed to load extracted_fields: ${extError.message}`);
  }
  if (!extracted) {
    throw new Error(`No extracted_fields row for document ${documentId}`);
  }

  const companyId = (doc.company_id as string) || "";
  if (!companyId) {
    throw new Error(`Document ${documentId} has no company_id`);
  }
  const { data: config } = await supabase
    .from("company_config")
    .select("duplicate_check_days, amount_requires_po_threshold, po_variance_pct, po_variance_amount")
    .eq("company_id", companyId)
    .maybeSingle();

  const daysRaw = config?.duplicate_check_days;
  const days = typeof daysRaw === "number"
    ? daysRaw
    : Number(daysRaw ?? DEFAULT_DUPLICATE_DAYS);

  const thresholdRaw = config?.amount_requires_po_threshold;
  const threshold = parseAmount(thresholdRaw) ?? DEFAULT_AMOUNT_PO_THRESHOLD;

  return {
    document_id: documentId,
    company_id: companyId,
    vendor_raw: (extracted.vendor_raw as string | null) ?? null,
    total_amount: parseAmount(extracted.total_amount),
    invoice_date: toDateOnly(extracted.invoice_date),
    has_supporting_document: Boolean(doc.has_supporting_document),
    po_number: (extracted.po_number as string | null) ?? null,
    tax_amount: parseAmount(extracted.tax_amount),
    extracted_fields_id: String(extracted.id),
    po_variance_pct: Number(config?.po_variance_pct ?? 2),
    po_variance_amount: Number(config?.po_variance_amount ?? 10),
    duplicate_check_days: Number.isFinite(days)
      ? Math.max(0, Math.floor(days))
      : DEFAULT_DUPLICATE_DAYS,
    amount_requires_po_threshold: threshold,
  };
}

/**
 * Purchase-order three-way match (item 7). Uses the POs synced into
 * zoho_entities (kind purchase_order) and the bill's extracted lines.
 */
async function checkPurchaseOrderMatch(
  supabase: SupabaseClient,
  ctx: { company_id: string; po_number: string | null; vendor_raw: string | null; total_amount: number | null; tax_amount: number | null; extracted_fields_id: string; po_variance_pct: number; po_variance_amount: number },
  vendorZohoId: string | null,
): Promise<{ result: CheckResult; detail: PoMatchResult }> {
  const { data: poRows } = await supabase.from("zoho_entities").select("zoho_id, name, extra").eq("kind", "purchase_order");
  const pos: PurchaseOrder[] = (poRows ?? []).map((r) => {
    const e = (r.extra as Record<string, unknown>) ?? {};
    return {
      zoho_id: String(r.zoho_id), number: String(r.name), reference: e.reference_number != null ? String(e.reference_number) : null, vendor_id: e.vendor_id != null ? String(e.vendor_id) : null, vendor_name: e.vendor_name != null ? String(e.vendor_name) : null,
      date: e.date != null ? String(e.date) : null, status: e.status != null ? String(e.status) : null, total: Number(e.total ?? 0) || 0,
      line_items: ((e.line_items as Array<Record<string, unknown>>) ?? []).map((l) => ({ line_item_id: l.line_item_id != null ? String(l.line_item_id) : null, name: l.name != null ? String(l.name) : null, description: l.description != null ? String(l.description) : null, quantity: Number(l.quantity ?? 0) || 0, quantity_billed: Number(l.quantity_billed ?? 0) || 0, rate: Number(l.rate ?? 0) || 0, item_total: Number(l.item_total ?? 0) || 0 })),
    };
  });
  const { data: lineRows } = await supabase.from("extracted_line_items").select("line_no, description, quantity, rate, amount").eq("extracted_fields_id", ctx.extracted_fields_id).order("line_no");
  const lines = (lineRows ?? []).map((l) => ({ line_no: Number(l.line_no), description: (l.description as string | null) ?? null, quantity: l.quantity == null ? null : Number(l.quantity), rate: l.rate == null ? null : Number(l.rate), amount: l.amount == null ? null : Number(l.amount) }));
  const detail = matchPurchaseOrder({ po_number: ctx.po_number, vendor_raw: ctx.vendor_raw, vendor_zoho_id: vendorZohoId, total_amount: ctx.total_amount, tax_amount: ctx.tax_amount, lines }, pos, { pct: ctx.po_variance_pct, amount: ctx.po_variance_amount });
  return { result: { passed: detail.passed, reason: detail.reason }, detail };
}

/** Same normalization the review UI uses to match vendor names (lib/zoho.ts). */
function normName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve the document's vendor to a synced Zoho vendor id (exact
 * normalized match only — no fuzzy containment here, since a wrong match
 * would apply another vendor's learned checks).
 */
async function resolveVendorZohoId(
  supabase: SupabaseClient,
  vendorRaw: string | null,
): Promise<{ zoho_id: string; name: string } | null> {
  const q = vendorRaw ? normName(vendorRaw) : "";
  if (!q) return null;
  const { data } = await supabase
    .from("zoho_entities")
    .select("zoho_id, name")
    .eq("kind", "vendor");
  for (const v of data ?? []) {
    if (normName(String(v.name)) === q) {
      return { zoho_id: String(v.zoho_id), name: String(v.name) };
    }
  }
  // Fall back to the learned party profiles: the vendor cache can lag the
  // history the learner read (a vendor seen in bills but not yet synced),
  // and a stale cache must never silently switch off a check the reviewer
  // enabled. Still an exact normalized match.
  const { data: profiles } = await supabase
    .from("bk_party_profiles")
    .select("party_zoho_id, party_name")
    .eq("party_kind", "vendor");
  for (const p of profiles ?? []) {
    if (normName(String(p.party_name)) === q) {
      return { zoho_id: String(p.party_zoho_id), name: String(p.party_name) };
    }
  }
  return null;
}

/** ONLY enabled checks. Proposed / dismissed / stale never reach the engine. */
async function loadEnabledChecks(
  supabase: SupabaseClient,
  companyId: string,
  vendorZohoId: string,
): Promise<EnabledCheck[]> {
  const { data } = await supabase
    .from("bk_check_proposals")
    .select("check_kind, params")
    .eq("company_id", companyId)
    .eq("party_kind", "vendor")
    .eq("party_zoho_id", vendorZohoId)
    .eq("status", "enabled");
  return (data ?? []) as EnabledCheck[];
}

/** Other documents from the same vendor (by normalized name), for the
 * recurring-period check. Excludes the document under judgment. */
async function loadVendorPeers(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  vendorRaw: string,
): Promise<PeerDoc[]> {
  const q = normName(vendorRaw);
  const { data: docs } = await supabase
    .from("documents")
    .select("id")
    .eq("company_id", companyId)
    .neq("id", documentId);
  const ids = (docs ?? []).map((d) => d.id as string);
  if (ids.length === 0) return [];
  const { data: peers } = await supabase
    .from("extracted_fields")
    .select("document_id, vendor_raw, invoice_date, total_amount")
    .in("document_id", ids);
  return (peers ?? [])
    .filter((p) => p.vendor_raw && normName(String(p.vendor_raw)) === q)
    .map((p) => ({
      document_id: String(p.document_id),
      invoice_date: toDateOnly(p.invoice_date),
      total_amount: parseAmount(p.total_amount),
    }));
}

async function persistResults(
  supabase: SupabaseClient,
  documentId: string,
  results: Array<{ rule_name: string; result: CheckResult }>,
): Promise<Array<{ id: string; rule_name: string; passed: boolean; notes: string }>> {
  // Replace prior rows for these checks on re-run. Also clear any
  // learned_* rows from a previous run whose check has since been
  // disabled — otherwise a stale failure would linger on the document.
  const ruleNames = results.map((r) => r.rule_name);
  await supabase
    .from("judgment_results")
    .delete()
    .eq("document_id", documentId)
    .in("rule_name", ruleNames);
  await supabase
    .from("judgment_results")
    .delete()
    .eq("document_id", documentId)
    .like("rule_name", "learned_%")
    .not("rule_name", "in", `(${ruleNames.map((n) => `"${n}"`).join(",")})`);

  const rows = results.map((r) => ({
    document_id: documentId,
    rule_name: r.rule_name,
    passed: r.result.passed,
    notes: r.result.reason,
  }));

  const { data, error } = await supabase
    .from("judgment_results")
    .insert(rows)
    .select("id, rule_name, passed, notes");

  if (error) {
    throw new Error(`Failed to store judgment_results: ${error.message}`);
  }
  return data ?? [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "POST required" }, 405);
  }

  const auth = await requireAuth(req, { allowServiceRole: true });
  if (isAuthFail(auth)) return auth.response;

  let input: JudgmentInput;
  try {
    input = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!input?.document_id) {
    return jsonResponse({ error: "document_id is required" }, 400);
  }

  // The caller handed us a document id. Establish that it is theirs before
  // reading anything off it — this function runs with the service role, so
  // nothing else will.
  const tenant = await companyForCaller(auth, {
    documentId: input.document_id,
    errorBody: (m) => ({ error: m }),
  });
  if (isCompanyFail(tenant)) return tenant.response;

  try {
    const supabase = getSupabase();
    const ctx = await loadContext(supabase, input.document_id);

    // Learned per-vendor checks: only those a human ENABLED, only for the
    // vendor this document matches. Absent a match or any enabled check,
    // the engine behaves exactly as before.
    const vendor = await resolveVendorZohoId(supabase, ctx.vendor_raw);
    const enabled = vendor
      ? await loadEnabledChecks(supabase, ctx.company_id, vendor.zoho_id)
      : [];

    const duplicate = await checkDuplicate(supabase, ctx);
    let supporting = checkMissingSupportingDocument(ctx);
    const amountPo = checkAmountAboveThresholdNoPo(ctx);

    // Strictness override replaces the base supporting-document verdict.
    const strictness = enabled.find(
      (e) => e.check_kind === "supporting_document_strictness",
    );
    if (strictness) {
      const overridden = applySupportingDocumentStrictness(
        ctx.has_supporting_document,
        strictness.params,
      );
      if (overridden) supporting = overridden;
    }

    const poMatch = await checkPurchaseOrderMatch(supabase, ctx, vendor?.zoho_id ?? null);

    const packaged = [
      { rule_name: JUDGMENT_CHECK_NAMES.duplicate, result: duplicate },
      { rule_name: JUDGMENT_CHECK_NAMES.supporting, result: supporting },
      { rule_name: JUDGMENT_CHECK_NAMES.amountPo, result: amountPo },
      { rule_name: "po_match", result: poMatch.result },
    ];

    const learnedApplied: string[] = [];
    if (enabled.some((e) => e.check_kind === "recurring_twice_in_period")) {
      const peers = await loadVendorPeers(
        supabase,
        ctx.company_id,
        input.document_id,
        ctx.vendor_raw ?? "",
      );
      packaged.push({
        rule_name: LEARNED_RULE_NAMES.recurring_twice_in_period,
        result: checkRecurringTwiceInPeriod(ctx.invoice_date, peers),
      });
      learnedApplied.push("recurring_twice_in_period");
    }
    const anomaly = enabled.find((e) => e.check_kind === "amount_anomaly");
    if (anomaly) {
      packaged.push({
        rule_name: LEARNED_RULE_NAMES.amount_anomaly,
        result: checkAmountAnomaly(ctx.total_amount, anomaly.params),
      });
      learnedApplied.push("amount_anomaly");
    }
    if (strictness) learnedApplied.push("supporting_document_strictness");

    const stored = await persistResults(supabase, input.document_id, packaged);

    const allPassed = packaged.every((p) => p.result.passed);
    // Record the verdict on the document — but a document that is already
    // in Zoho Books (synced) or mid-push (sync_failed) keeps that status: a
    // re-run (e.g. a duplicate arriving later) must not pull it back into
    // the review queue as if it had never been posted. The results are
    // still stored and visible on the review screen.
    await supabase
      .from("documents")
      .update({ status: allPassed ? "judgment_passed" : "needs_review" })
      .eq("id", input.document_id)
      .not("status", "in", '("synced","sync_failed")');

    return jsonResponse({
      ok: true,
      document_id: input.document_id,
      company_id: ctx.company_id,
      all_passed: allPassed,
      po_match: poMatch.detail,
      config: {
        duplicate_check_days: ctx.duplicate_check_days,
        amount_requires_po_threshold: ctx.amount_requires_po_threshold,
      },
      learned: {
        vendor_matched: vendor,
        enabled_checks_applied: learnedApplied,
      },
      checks: packaged.map((p) => ({
        rule_name: p.rule_name,
        passed: p.result.passed,
        reason: p.result.reason,
      })),
      judgment_results: stored,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Judgment failed:", message);
    return jsonResponse({ ok: false, error: message }, 200);
  }
});
