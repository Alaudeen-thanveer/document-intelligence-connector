/**
 * Three hardcoded judgment checks for this step only.
 * Each returns { passed, reason }. Persistence into judgment_results is
 * handled by the judgment edge function — not a pluggable rules engine.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface CheckResult {
  passed: boolean;
  reason: string;
}

export interface JudgmentCheckContext {
  document_id: string;
  company_id: string;
  vendor_raw: string | null;
  total_amount: number | null;
  invoice_date: string | null; // YYYY-MM-DD
  has_supporting_document: boolean;
  po_number: string | null;
  duplicate_check_days: number;
  amount_requires_po_threshold: number;
}

function normalizeVendor(vendor: string | null): string | null {
  if (vendor == null) return null;
  const t = vendor.trim().toLowerCase();
  return t.length ? t : null;
}

function parseAmount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDateOnly(value: string | Date | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * 1. Duplicate: same vendor + amount + date within configurable days (default 3).
 */
export async function checkDuplicate(
  supabase: SupabaseClient,
  ctx: JudgmentCheckContext,
): Promise<CheckResult> {
  const vendor = normalizeVendor(ctx.vendor_raw);
  const amount = parseAmount(ctx.total_amount);
  const invoiceDate = toDateOnly(ctx.invoice_date);

  if (!vendor || amount === null || !invoiceDate) {
    return {
      passed: true,
      reason:
        "Duplicate check skipped: vendor, amount, or invoice date is missing.",
    };
  }

  const windowDays = Math.max(0, Math.floor(ctx.duplicate_check_days));

  const { data: companyDocs, error: docsError } = await supabase
    .from("documents")
    .select("id")
    .eq("company_id", ctx.company_id)
    .neq("id", ctx.document_id);

  if (docsError) {
    return {
      passed: false,
      reason: `Duplicate check could not query company documents: ${docsError.message}`,
    };
  }

  const peerDocIds = (companyDocs ?? []).map((d) => d.id as string);
  if (peerDocIds.length === 0) {
    return {
      passed: true,
      reason:
        `No duplicate found for vendor+amount+date within ${windowDays} day(s).`,
    };
  }

  const { data: peers, error } = await supabase
    .from("extracted_fields")
    .select("document_id, vendor_raw, total_amount, invoice_date")
    .in("document_id", peerDocIds);

  if (error) {
    return {
      passed: false,
      reason: `Duplicate check could not query peers: ${error.message}`,
    };
  }

  const matches: string[] = [];
  for (const peer of peers ?? []) {
    const peerVendor = normalizeVendor(peer.vendor_raw as string | null);
    const peerAmount = parseAmount(peer.total_amount as number | string | null);
    const peerDate = toDateOnly(peer.invoice_date as string | null);
    if (!peerVendor || peerAmount === null || !peerDate) continue;
    if (peerVendor !== vendor) continue;
    if (peerAmount !== amount) continue;
    if (daysBetween(invoiceDate, peerDate) > windowDays) continue;
    matches.push(String(peer.document_id));
  }

  if (matches.length > 0) {
    return {
      passed: false,
      reason:
        `Duplicate invoice detected: same vendor ("${ctx.vendor_raw}"), amount (${amount}), and date within ${windowDays} day(s). Matching document_id(s): ${matches.join(", ")}.`,
    };
  }

  return {
    passed: true,
    reason:
      `No duplicate found for vendor+amount+date within ${windowDays} day(s).`,
  };
}

/**
 * 2. Missing supporting document.
 */
export function checkMissingSupportingDocument(
  ctx: JudgmentCheckContext,
): CheckResult {
  if (ctx.has_supporting_document) {
    return {
      passed: true,
      reason: "Supporting document is present.",
    };
  }
  return {
    passed: false,
    reason: "Missing supporting document for this invoice.",
  };
}

/**
 * 3. Amount above per-company threshold with no PO.
 */
export function checkAmountAboveThresholdNoPo(
  ctx: JudgmentCheckContext,
): CheckResult {
  const amount = parseAmount(ctx.total_amount);
  const threshold = parseAmount(ctx.amount_requires_po_threshold) ?? 0;
  const po = ctx.po_number?.trim() ?? "";

  if (amount === null) {
    return {
      passed: true,
      reason: "Amount/PO check skipped: total_amount is missing.",
    };
  }

  if (amount <= threshold) {
    return {
      passed: true,
      reason:
        `Amount ${amount} is within company PO threshold ${threshold}; PO not required.`,
    };
  }

  if (po.length > 0) {
    return {
      passed: true,
      reason:
        `Amount ${amount} exceeds threshold ${threshold}, but PO "${po}" is present.`,
    };
  }

  return {
    passed: false,
    reason:
      `Amount ${amount} exceeds company threshold ${threshold} and no PO number was provided.`,
  };
}

export const JUDGMENT_CHECK_NAMES = {
  duplicate: "duplicate_vendor_amount_date",
  supporting: "missing_supporting_document",
  amountPo: "amount_above_threshold_no_po",
} as const;
