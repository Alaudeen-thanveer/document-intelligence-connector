/**
 * Run the three hardcoded judgment checks for a document and store each
 * result in judgment_results. Not a pluggable rules engine.
 *
 * Input: { document_id: string }
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  checkAmountAboveThresholdNoPo,
  checkDuplicate,
  checkMissingSupportingDocument,
  JUDGMENT_CHECK_NAMES,
  type CheckResult,
  type JudgmentCheckContext,
} from "./checks.ts";

const DEFAULT_COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_DUPLICATE_DAYS = 3;
const DEFAULT_AMOUNT_PO_THRESHOLD = 5000;

interface JudgmentInput {
  document_id: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
    .select("vendor_raw, total_amount, invoice_date, po_number")
    .eq("document_id", documentId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (extError) {
    throw new Error(`Failed to load extracted_fields: ${extError.message}`);
  }
  if (!extracted) {
    throw new Error(`No extracted_fields row for document ${documentId}`);
  }

  const companyId = (doc.company_id as string) || DEFAULT_COMPANY_ID;
  const { data: config } = await supabase
    .from("company_config")
    .select("duplicate_check_days, amount_requires_po_threshold")
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
    duplicate_check_days: Number.isFinite(days)
      ? Math.max(0, Math.floor(days))
      : DEFAULT_DUPLICATE_DAYS,
    amount_requires_po_threshold: threshold,
  };
}

async function persistResults(
  supabase: SupabaseClient,
  documentId: string,
  results: Array<{ rule_name: string; result: CheckResult }>,
): Promise<Array<{ id: string; rule_name: string; passed: boolean; notes: string }>> {
  // Replace prior rows for these three hardcoded checks on re-run.
  const ruleNames = results.map((r) => r.rule_name);
  await supabase
    .from("judgment_results")
    .delete()
    .eq("document_id", documentId)
    .in("rule_name", ruleNames);

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
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type, apikey",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "POST required" }, 405);
  }

  let input: JudgmentInput;
  try {
    input = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!input?.document_id) {
    return jsonResponse({ error: "document_id is required" }, 400);
  }

  try {
    const supabase = getSupabase();
    const ctx = await loadContext(supabase, input.document_id);

    const duplicate = await checkDuplicate(supabase, ctx);
    const supporting = checkMissingSupportingDocument(ctx);
    const amountPo = checkAmountAboveThresholdNoPo(ctx);

    const packaged = [
      { rule_name: JUDGMENT_CHECK_NAMES.duplicate, result: duplicate },
      { rule_name: JUDGMENT_CHECK_NAMES.supporting, result: supporting },
      { rule_name: JUDGMENT_CHECK_NAMES.amountPo, result: amountPo },
    ];

    const stored = await persistResults(supabase, input.document_id, packaged);

    const allPassed = packaged.every((p) => p.result.passed);
    await supabase
      .from("documents")
      .update({ status: allPassed ? "judgment_passed" : "needs_review" })
      .eq("id", input.document_id);

    return jsonResponse({
      ok: true,
      document_id: input.document_id,
      company_id: ctx.company_id,
      all_passed: allPassed,
      config: {
        duplicate_check_days: ctx.duplicate_check_days,
        amount_requires_po_threshold: ctx.amount_requires_po_threshold,
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
