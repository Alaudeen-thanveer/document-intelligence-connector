import type { ZohoEntityRow } from "../types";

/** Normalize a name for vendor/customer matching (mirrors match-entities). */
export function normName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exact normalized match wins; otherwise first containment match. */
export function findByName<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
): T | null {
  const q = normName(query);
  if (!q) return null;
  let containment: T | null = null;
  for (const item of items) {
    const c = normName(getName(item));
    if (!c) continue;
    if (c === q) return item;
    if (!containment && (c.includes(q) || q.includes(c))) containment = item;
  }
  return containment;
}

export function entityAccountType(a: ZohoEntityRow): string {
  return String(
    (a.extra as { account_type?: unknown } | null)?.account_type ?? "",
  ).toLowerCase();
}

/** Accounts a bill/expense can be posted to (expense-ish, or untyped). */
export function isPostingAccount(a: ZohoEntityRow): boolean {
  const t = entityAccountType(a);
  if (!t) return true;
  return t.includes("expense") || t.includes("cost_of_goods");
}

/** Accounts an invoice line can be posted to (income-ish, or untyped). */
export function isIncomeAccount(a: ZohoEntityRow): boolean {
  const t = entityAccountType(a);
  if (!t) return true;
  return t.includes("income");
}
