/**
 * Zoho Books bank rules — pure.
 *
 * The org's own bank rules are the bookkeeper's explicit habits, written
 * down: "description contains ETISALAT → expense, Telephone, vendor X".
 * They are evidence at decision time: when a statement line satisfies a
 * rule's criteria, we propose what the rule records — labelled as the
 * rule, with its mode (recognize = Zoho would only suggest it too;
 * autocategorize = Zoho would post it on its own).
 *
 * The reverse direction: a learned pattern that is strong enough can be
 * proposed AS a Zoho rule, always in "recognize" (suggest-only) mode, so
 * Zoho's own screen starts suggesting the same thing. Never autocategorize.
 */
import type { BankPattern } from "../bookkeeping-learn/bank_patterns.ts";
import type { Suggestion } from "./suggest.ts";

export interface ZohoBankRule {
  rule_id: string;
  rule_name: string;
  rule_category?: string | null; // selected_accounts | all_accounts | all_banks | all_credit_cards
  account_ids?: string | string[] | null;
  apply_to?: string | null; // deposits | withdrawals
  criteria_type?: string | null; // and | or
  criterion: Array<{ field: string; comparator: string; value: string | number }>;
  record_as?: string | null;
  account_id?: string | null;
  account_name?: string | null;
  customer_id?: string | null;
  vendor_id?: string | null;
  auto_categorize?: string | null; // autocategorize | recognize
  is_active?: boolean | null;
}

export interface RuleLine {
  description: string;
  reference: string | null;
  payee?: string | null;
  side: "debit" | "credit";
  amount: number;
}

function testCriterion(line: RuleLine, c: { field: string; comparator: string; value: string | number }): boolean {
  const f = String(c.field ?? "").toLowerCase();
  const cmp = String(c.comparator ?? "").toLowerCase();
  if (f === "amount") {
    const v = Number(c.value); const a = line.amount;
    if (!Number.isFinite(v)) return false;
    switch (cmp) {
      case "equals": case "is": return Math.abs(a - v) <= 0.005;
      case "is_not": return Math.abs(a - v) > 0.005;
      case "less_than": return a < v;
      case "greater_than": return a > v;
      case "less_than_or_equals": return a <= v;
      case "greater_than_or_equals": return a >= v;
      default: return false;
    }
  }
  const hay = (f === "payee" ? (line.payee ?? "") : f === "reference_number" ? (line.reference ?? "") : line.description).toLowerCase();
  const needle = String(c.value ?? "").toLowerCase().trim();
  if (!needle) return false;
  switch (cmp) {
    case "contains": return hay.includes(needle);
    case "is": case "equals": return hay === needle;
    case "is_not": return hay !== needle;
    case "starts_with": return hay.startsWith(needle);
    case "ends_with": return hay.endsWith(needle);
    default: return false;
  }
}

/** Does this rule apply to the line at all (side, account scope, active)? */
export function ruleApplies(line: RuleLine, rule: ZohoBankRule, bankAccountId: string | null): boolean {
  if (rule.is_active === false) return false;
  const applyTo = String(rule.apply_to ?? "").toLowerCase();
  if (applyTo === "deposits" && line.side !== "credit") return false;
  if (applyTo === "withdrawals" && line.side !== "debit") return false;
  const cat = String(rule.rule_category ?? "").toLowerCase();
  if (cat === "selected_accounts" && bankAccountId) {
    const ids = Array.isArray(rule.account_ids) ? rule.account_ids.map(String) : String(rule.account_ids ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (ids.length && !ids.includes(bankAccountId)) return false;
  }
  const crits = rule.criterion ?? [];
  if (!crits.length) return false;
  const results = crits.map((c) => testCriterion(line, c));
  return String(rule.criteria_type ?? "and").toLowerCase() === "or" ? results.some(Boolean) : results.every(Boolean);
}

/** Zoho record_as → our kind. Rules can only categorise (never payments). */
export function kindForRecordAs(recordAs: string | null | undefined): Suggestion["txn_kind"] | null {
  const r = String(recordAs ?? "").toLowerCase();
  if (!r) return null;
  if (r === "expense" || r === "card_payment") return "expense";
  if (r === "transfer_fund") return "transfer";
  if (["deposit", "sales_without_invoices", "interest_income", "other_income", "owner_contribution", "expense_refund", "refund"].includes(r)) return "deposit";
  if (r === "owner_drawings") return "other";
  return "other";
}

/** First matching rule → a suggestion; null when none applies. */
export function suggestFromZohoRules(line: RuleLine, rules: ZohoBankRule[], bankAccountId: string | null): Suggestion | null {
  for (const rule of rules) {
    if (!ruleApplies(line, rule, bankAccountId)) continue;
    const kind = kindForRecordAs(rule.record_as);
    if (!kind) continue;
    const auto = String(rule.auto_categorize ?? "").toLowerCase() === "autocategorize";
    // Zoho uses "" for absent ids — treat as missing.
    const vendorId = rule.vendor_id || null;
    const customerId = rule.customer_id || null;
    const partyKind = vendorId ? "vendor" : customerId ? "customer" : null;
    return {
      txn_kind: kind,
      party_kind: partyKind,
      party_zoho_id: vendorId ?? customerId,
      party_name: null,
      account_id: rule.account_id ?? null,
      account_name: rule.account_name ?? null,
      doc_kind: null, doc_zoho_id: null, doc_number: null, doc_balance: null,
      allocations: [], advance_amount: 0, bank_charges: 0, residual: 0, writeoff: null,
      ref_kind: null, ref_zoho_id: null, ref_number: null, candidates: [],
      confidence: auto ? 0.95 : 0.9,
      source: "zoho_rule",
      reason: `Zoho Books bank rule “${rule.rule_name}” (${auto ? "auto-categorise" : "suggest-only"}) matches this line → ${String(rule.record_as).replace(/_/g, " ")}${rule.account_name ? ` to ${rule.account_name}` : ""}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proposing a learned pattern AS a Zoho rule
// ---------------------------------------------------------------------------

export const RULE_PROPOSAL_MIN_CONFIDENCE = 0.9;
export const RULE_PROPOSAL_MIN_SAMPLES = 12;

/** Rules can only categorise: expenses, deposits, transfers — never payments, refunds, matches. */
export function isProposableAsZohoRule(p: BankPattern & { zoho_rule_id?: string | null; suggestion_status?: string }): { ok: boolean; why: string } {
  if (p.zoho_rule_id) return { ok: false, why: "already proposed as a Zoho rule" };
  if (p.suggestion_status === "dismissed") return { ok: false, why: "dismissed" };
  if (!["expense", "deposit", "transfer"].includes(p.txn_kind)) return { ok: false, why: `Zoho rules cannot record a ${p.txn_kind.replace(/_/g, " ")} — that needs an allocation a rule cannot know` };
  if (!p.account_id) return { ok: false, why: "no account learned" };
  if (p.confidence < RULE_PROPOSAL_MIN_CONFIDENCE) return { ok: false, why: `confidence ${p.confidence} < ${RULE_PROPOSAL_MIN_CONFIDENCE}` };
  if (p.sample_size < RULE_PROPOSAL_MIN_SAMPLES) return { ok: false, why: `${p.sample_size} samples < ${RULE_PROPOSAL_MIN_SAMPLES}` };
  if (!p.tokens.length) return { ok: false, why: "no identifying words" };
  return { ok: true, why: "" };
}

/** The Zoho rule body for a pattern — recognize (suggest-only), all banks, description contains every fingerprint word. */
export function zohoRuleBodyForPattern(p: BankPattern, opts: { bankAccountIds?: string[] } = {}): Record<string, unknown> {
  const recordAs = p.txn_kind === "expense" ? "expense" : p.txn_kind === "deposit" ? "deposit" : "transfer_fund";
  const body: Record<string, unknown> = {
    rule_name: `Learned: ${p.tokens.join(" ")} → ${p.account_name ?? recordAs}`.slice(0, 100),
    rule_category: opts.bankAccountIds?.length ? "selected_accounts" : "all_banks",
    ...(opts.bankAccountIds?.length ? { account_ids: opts.bankAccountIds.join(",") } : {}),
    apply_to: p.side === "debit" ? "withdrawals" : "deposits",
    criteria_type: "and",
    criterion: p.tokens.map((t) => ({ field: "description", comparator: "contains", value: t })),
    record_as: recordAs,
    account_id: p.account_id,
    // Suggest-only. Zoho will show it on its own screen; a human still clicks.
    auto_categorize: "recognize",
  };
  if (p.party_kind === "vendor" && p.party_zoho_id) body.vendor_id = p.party_zoho_id;
  if (p.party_kind === "customer" && p.party_zoho_id) body.customer_id = p.party_zoho_id;
  return body;
}
