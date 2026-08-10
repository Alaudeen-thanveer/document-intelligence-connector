/**
 * Resolve Zoho vendor_id and GL account_id from a mapped bill + cached lists.
 *
 * Uses fuzzy name matching. If confidence is below the auto-match threshold,
 * returns unresolved flags for human review — never silently picks the closest match.
 *
 * Pure / unit-testable: no network calls.
 */

import type { ZohoBillMapped, ZohoBillLineItem } from "./mapping.ts";

/** Minimum similarity required to auto-accept a match. */
export const AUTO_MATCH_THRESHOLD = 0.85;

export interface ZohoVendor {
  /** Zoho Books contact/vendor id */
  vendor_id: string;
  /** Display / contact name */
  vendor_name: string;
}

export interface ZohoAccount {
  account_id: string;
  account_name: string;
  /** Optional Zoho account_type (e.g. expense) — used only as a soft filter. */
  account_type?: string | null;
}

export interface MatchEntitiesInput {
  bill: ZohoBillMapped;
  vendors: ZohoVendor[];
  accounts: ZohoAccount[];
  /**
   * Expense category label to resolve to a GL account.
   * If omitted, falls back to the first line item description when it
   * looks like a category (not the default "Bill from …" text).
   */
  expense_category?: string | null;
}

export type UnresolvedField = "vendor" | "account";

export interface VendorMatch {
  vendor_id: string;
  vendor_name: string;
  confidence: number;
}

export interface AccountMatch {
  account_id: string;
  account_name: string;
  confidence: number;
}

export interface MatchEntitiesResult {
  /** Bill with vendor_id / account_id filled only when confidently resolved. */
  bill: ZohoBillMapped;
  /** True when any required entity could not be auto-matched. */
  unresolved: boolean;
  unresolved_fields: UnresolvedField[];
  vendor_match: VendorMatch | null;
  account_match: AccountMatch | null;
}

const NOISE_TOKENS = new Set([
  "inc",
  "inc.",
  "llc",
  "ltd",
  "ltd.",
  "co",
  "co.",
  "corp",
  "corp.",
  "company",
  "the",
  "and",
  "&",
]);

/** Normalize a name for comparison. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeName(value)
    .split(" ")
    .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function editSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Combined fuzzy score in [0, 1]. Exact / containment gets a boost so clear
 * substring matches (e.g. "Acme" vs "Acme Supplies LLC") can clear the bar.
 */
export function fuzzyNameScore(query: string, candidate: string): number {
  const nq = normalizeName(query);
  const nc = normalizeName(candidate);
  if (!nq || !nc) return 0;
  if (nq === nc) return 1;

  const edit = editSimilarity(nq, nc);
  const token = tokenSimilarity(nq, nc);
  let score = Math.max(edit, 0.55 * edit + 0.45 * token);

  if (nc.includes(nq) || nq.includes(nc)) {
    const containment =
      Math.min(nq.length, nc.length) / Math.max(nq.length, nc.length);
    score = Math.max(score, 0.8 + 0.2 * containment);
  }

  return Math.max(0, Math.min(1, score));
}

interface Ranked<T> {
  item: T;
  confidence: number;
}

function bestFuzzyMatch<T>(
  query: string | null | undefined,
  items: T[],
  getName: (item: T) => string,
): Ranked<T> | null {
  if (!query || !query.trim() || items.length === 0) return null;

  let best: Ranked<T> | null = null;
  for (const item of items) {
    const confidence = fuzzyNameScore(query, getName(item));
    if (!best || confidence > best.confidence) {
      best = { item, confidence };
    }
  }
  return best;
}

/**
 * Accept a ranked candidate only if it clears AUTO_MATCH_THRESHOLD.
 * Closest-below-threshold matches are discarded (human review).
 */
function acceptIfConfident<T>(
  ranked: Ranked<T> | null,
  threshold = AUTO_MATCH_THRESHOLD,
): Ranked<T> | null {
  if (!ranked) return null;
  if (ranked.confidence < threshold) return null;
  return ranked;
}

function resolveExpenseQuery(
  expenseCategory: string | null | undefined,
  bill: ZohoBillMapped,
): string | null {
  if (expenseCategory && expenseCategory.trim()) return expenseCategory.trim();

  const desc = bill.line_items[0]?.description?.trim();
  if (!desc) return null;
  // Mapped default description is not a real category signal.
  if (/^bill from /i.test(desc) || desc === "Imported bill") return null;
  return desc;
}

/**
 * Match vendor + expense GL account for a mapped bill.
 * Unresolved entities are left empty and flagged — never guessed.
 */
export function matchEntities(input: MatchEntitiesInput): MatchEntitiesResult {
  const unresolvedFields: UnresolvedField[] = [];

  const vendorRanked = acceptIfConfident(
    bestFuzzyMatch(input.bill.vendor_name, input.vendors, (v) => v.vendor_name),
  );

  const expenseQuery = resolveExpenseQuery(input.expense_category, input.bill);
  const expenseAccounts = input.accounts.filter((a) => {
    if (!a.account_type) return true;
    const t = a.account_type.toLowerCase();
    return (
      t.includes("expense") ||
      t.includes("cost of goods") ||
      t === "cost_of_goods_sold"
    );
  });
  const accountPool = expenseAccounts.length > 0 ? expenseAccounts : input.accounts;
  const accountRanked = acceptIfConfident(
    bestFuzzyMatch(expenseQuery, accountPool, (a) => a.account_name),
  );

  const vendorMatch: VendorMatch | null = vendorRanked
    ? {
      vendor_id: vendorRanked.item.vendor_id,
      vendor_name: vendorRanked.item.vendor_name,
      confidence: vendorRanked.confidence,
    }
    : null;

  const accountMatch: AccountMatch | null = accountRanked
    ? {
      account_id: accountRanked.item.account_id,
      account_name: accountRanked.item.account_name,
      confidence: accountRanked.confidence,
    }
    : null;

  if (!vendorMatch) unresolvedFields.push("vendor");
  if (!accountMatch) unresolvedFields.push("account");

  const lineItems: ZohoBillLineItem[] = input.bill.line_items.map((item, index) => {
    if (index === 0 && accountMatch) {
      return { ...item, account_id: accountMatch.account_id };
    }
    const { account_id: _drop, ...rest } = item;
    return rest;
  });

  const bill: ZohoBillMapped = {
    date: input.bill.date,
    vendor_name: input.bill.vendor_name,
    line_items: lineItems,
    ...(input.bill.reference_number
      ? { reference_number: input.bill.reference_number }
      : {}),
    ...(vendorMatch ? { vendor_id: vendorMatch.vendor_id } : {}),
  };

  return {
    bill,
    unresolved: unresolvedFields.length > 0,
    unresolved_fields: unresolvedFields,
    vendor_match: vendorMatch,
    account_match: accountMatch,
  };
}
