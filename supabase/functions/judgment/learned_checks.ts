/**
 * Learned per-vendor checks. Pure — no I/O, no Deno APIs.
 *
 * These run ONLY for checks a human has enabled in bk_check_proposals
 * (status = 'enabled'). A proposed or dismissed check never reaches here.
 * See docs/BOOKKEEPING_PATTERNS_SPEC.md §3.2, §3.5, §6.
 *
 * Every function is deterministic on its inputs so the engine's behaviour
 * can be tested without a database.
 */

export interface CheckResult {
  passed: boolean;
  reason: string;
}

/** A row from bk_check_proposals with status = 'enabled'. */
export interface EnabledCheck {
  check_kind:
    | "recurring_twice_in_period"
    | "amount_anomaly"
    | "expected_missing"
    | "supporting_document_strictness";
  params: Record<string, unknown>;
}

/** A sibling document from the same vendor (from extracted_fields history). */
export interface PeerDoc {
  document_id: string;
  invoice_date: string | null; // yyyy-mm-dd
  total_amount: number | null;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Twice in one period: for a recurring vendor, another document from the
 * same vendor in the same calendar month is suspicious even at a different
 * amount. `peers` excludes the document under judgment.
 */
export function checkRecurringTwiceInPeriod(
  invoiceDate: string | null,
  peers: PeerDoc[],
): CheckResult {
  if (!invoiceDate) {
    return { passed: true, reason: "Recurring-period check skipped: no invoice date." };
  }
  const month = monthKey(invoiceDate);
  const hits = peers.filter((p) => p.invoice_date && monthKey(p.invoice_date) === month);
  if (hits.length > 0) {
    return {
      passed: false,
      reason:
        `This vendor bills once a month, but ${hits.length} other document(s) already exist for ${month}` +
        ` (${hits.map((h) => h.document_id.slice(0, 8)).join(", ")}). Possible duplicate.`,
    };
  }
  return { passed: true, reason: `Only document from this recurring vendor in ${month}.` };
}

/**
 * Amount anomaly. Two parameter shapes, from the learner:
 *   { kind: "fixed", median, tolerance_pct }         → |amount − median| ≤ tol%
 *   { kind: "variable", p10, p90, multiplier }       → within band widened ×multiplier
 */
export function checkAmountAnomaly(
  amount: number | null,
  params: Record<string, unknown>,
): CheckResult {
  if (amount === null) {
    return { passed: true, reason: "Amount-anomaly check skipped: no total amount." };
  }
  const kind = String(params.kind ?? "");
  if (kind === "fixed") {
    const median = num(params.median);
    const tol = num(params.tolerance_pct) ?? 5;
    if (median === null || median <= 0) {
      return { passed: true, reason: "Amount-anomaly check skipped: no learned median." };
    }
    const deviation = Math.abs(amount - median) / median * 100;
    if (deviation > tol) {
      return {
        passed: false,
        reason:
          `Amount ${amount} deviates ${deviation.toFixed(1)}% from this vendor's usual ${median}` +
          ` (tolerance ${tol}%).`,
      };
    }
    return { passed: true, reason: `Amount ${amount} is within ${tol}% of the usual ${median}.` };
  }
  if (kind === "variable") {
    const p10 = num(params.p10);
    const p90 = num(params.p90);
    const mult = num(params.multiplier) ?? 3;
    if (p10 === null || p90 === null) {
      return { passed: true, reason: "Amount-anomaly check skipped: no learned range." };
    }
    // Widen the p10–p90 band around its centre by the multiplier.
    const centre = (p10 + p90) / 2;
    const half = Math.max((p90 - p10) / 2, centre * 0.05); // never a zero-width band
    const lo = Math.max(0, centre - half * mult);
    const hi = centre + half * mult;
    if (amount < lo || amount > hi) {
      return {
        passed: false,
        reason:
          `Amount ${amount} is outside this vendor's usual range ${p10}–${p90}` +
          ` (even allowing ${mult}× the spread: ${lo.toFixed(2)}–${hi.toFixed(2)}).`,
      };
    }
    return {
      passed: true,
      reason: `Amount ${amount} is within this vendor's usual range (${p10}–${p90}, ×${mult}).`,
    };
  }
  return { passed: true, reason: `Amount-anomaly check skipped: unknown kind "${kind}".` };
}

/**
 * Supporting-document strictness overrides the standard check per vendor:
 *   strict   → fail unless a supporting document is present (same as the
 *              base check, but the reason names the vendor's convention)
 *   relaxed  → always pass; this vendor's bills historically carry none
 *   standard → defer to the base check (returns null)
 */
export function applySupportingDocumentStrictness(
  hasSupportingDocument: boolean,
  params: Record<string, unknown>,
): CheckResult | null {
  const strictness = String(params.strictness ?? "standard");
  if (strictness === "relaxed") {
    return {
      passed: true,
      reason:
        "Supporting document not required for this vendor: its bills historically carry no attachment (learned convention, enabled by reviewer).",
    };
  }
  if (strictness === "strict") {
    const tokens = Array.isArray(params.recurring_name_tokens)
      ? (params.recurring_name_tokens as unknown[]).map(String).join("/")
      : "";
    if (hasSupportingDocument) {
      return { passed: true, reason: "Supporting document is present (vendor convention: required)." };
    }
    return {
      passed: false,
      reason:
        `Missing supporting document — this vendor's bills usually carry ${
          tokens ? `a ${tokens}` : "an extra file"
        } (learned convention, enabled by reviewer).`,
    };
  }
  return null;
}

/** Stable rule names for judgment_results rows written by learned checks. */
export const LEARNED_RULE_NAMES = {
  recurring_twice_in_period: "learned_recurring_twice_in_period",
  amount_anomaly: "learned_amount_anomaly",
} as const;
