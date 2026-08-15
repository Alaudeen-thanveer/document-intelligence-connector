/**
 * Layer 5: manual journal patterns beyond Zoho's recurring definitions.
 * Pure — no I/O. See docs/BOOKKEEPING_PATTERNS_SPEC.md §3.3.
 *
 * Accountants often post the same journal every month by hand — an accrual,
 * a prepayment release, a provision — without ever setting it up as a Zoho
 * recurring journal. Those are found by FINGERPRINTING each journal by the
 * set of accounts it touches (with debit/credit sides), grouping journals
 * that share a fingerprint, and classifying the group's cadence with the
 * same recurrence logic used for bills.
 *
 * Output is a proposal ("undeclared recurring journal"); once a human
 * enables it, month-end treats it exactly like a declared recurring
 * journal — due vs posted for the period.
 */
import { classifyRhythm, type Rhythm } from "./recurrence.ts";

export interface JournalForPattern {
  journal_id: string;
  date: string; // yyyy-mm-dd
  reference_number: string | null;
  notes: string | null;
  total: number;
  /** True when Zoho created it from a recurring definition. */
  from_recurring: boolean;
  lines: Array<{
    account_id: string;
    account_name: string | null;
    debit: number;
    credit: number;
  }>;
}

export interface JournalPattern {
  /** Stable id: sorted "account_id:D|C" joined with "+". */
  fingerprint: string;
  /** Human label from account names, e.g. "Dr Prepaid Rent / Cr Rent Expense". */
  label: string;
  accounts: Array<{ account_id: string; account_name: string | null; side: "D" | "C" }>;
  cadence: Rhythm["cadence"];
  monthly_coverage: number;
  expected_day_min: number | null;
  expected_day_max: number | null;
  amount_median: number | null;
  amount_cv: number | null;
  sample_size: number;
  first_seen: string;
  last_seen: string;
  next_expected: string | null;
  confidence: number;
  /** Notes text that recurs across the group, if any (helps naming). */
  recurring_note: string | null;
  example_journal_ids: string[];
}

export const MIN_JOURNAL_PATTERN_SAMPLE = 3;

export function fingerprintJournal(j: JournalForPattern): string {
  const parts = new Set<string>();
  for (const l of j.lines) {
    if (!l.account_id) continue;
    if (l.debit > 0) parts.add(`${l.account_id}:D`);
    if (l.credit > 0) parts.add(`${l.account_id}:C`);
  }
  return [...parts].sort().join("+");
}

function commonNote(notes: Array<string | null>): string | null {
  // The most frequent normalized note, if it appears on ≥ 50% of journals.
  const counts = new Map<string, { raw: string; n: number }>();
  let total = 0;
  for (const n of notes) {
    if (!n) continue;
    total++;
    // Strip the period from the note so "Accrual Jan 2026" and "Accrual
    // Feb 2026" (or 1/2026, 2026-01, 31-01-2026 …) collapse to one key.
    const key = n
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g, "") // 31/01/2026
      .replace(/\b\d{4}-\d{2}(-\d{2})?\b/g, "")            // 2026-01, 2026-01-31
      .replace(/\b\d{1,2}[\/.-]\d{4}\b/g, "")               // 1/2026
      .replace(/\b[a-z]{3,9}\.? ?\d{2,4}\b/g, "")            // jan 2026, january 26
      .replace(/\b(q[1-4]|h[12])\b/g, "")
      .replace(/[\s\-\/:,.]+$/g, "")
      .trim();
    if (!key) continue;
    const e = counts.get(key) ?? { raw: n.trim(), n: 0 };
    e.n++;
    counts.set(key, e);
  }
  let best: { raw: string; n: number } | null = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  return best && total > 0 && best.n / total >= 0.5 ? best.raw : null;
}

/**
 * Group MANUAL journals (from_recurring = false) by fingerprint and classify
 * each group's cadence. Groups below MIN sample, or irregular, are still
 * returned (for evidence) but are not proposable.
 */
export function findJournalPatterns(journals: JournalForPattern[]): JournalPattern[] {
  const groups = new Map<string, JournalForPattern[]>();
  for (const j of journals) {
    if (j.from_recurring) continue; // declared recurring — layer C already covers it
    if (!/^\d{4}-\d{2}-\d{2}$/.test(j.date)) continue;
    const fp = fingerprintJournal(j);
    if (!fp) continue;
    const list = groups.get(fp) ?? [];
    list.push(j);
    groups.set(fp, list);
  }

  const out: JournalPattern[] = [];
  for (const [fingerprint, list] of groups) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const rhythm = classifyRhythm(list.map((j) => ({ date: j.date, total: j.total })));
    // Account descriptors from the first journal (all share the fingerprint).
    const first = list[0];
    const accounts: JournalPattern["accounts"] = [];
    const seen = new Set<string>();
    for (const l of first.lines) {
      for (const side of (["D", "C"] as const)) {
        const has = side === "D" ? l.debit > 0 : l.credit > 0;
        const k = `${l.account_id}:${side}`;
        if (has && !seen.has(k)) {
          seen.add(k);
          accounts.push({ account_id: l.account_id, account_name: l.account_name, side });
        }
      }
    }
    const dr = accounts.filter((a) => a.side === "D").map((a) => a.account_name ?? a.account_id);
    const cr = accounts.filter((a) => a.side === "C").map((a) => a.account_name ?? a.account_id);
    const label = `Dr ${dr.join(", ")} / Cr ${cr.join(", ")}`;

    out.push({
      fingerprint,
      label,
      accounts,
      cadence: rhythm.cadence,
      monthly_coverage: rhythm.monthly_coverage,
      expected_day_min: rhythm.expected_day_min,
      expected_day_max: rhythm.expected_day_max,
      amount_median: rhythm.amount_median,
      amount_cv: rhythm.amount_cv,
      sample_size: list.length,
      first_seen: list[0].date,
      last_seen: list[list.length - 1].date,
      next_expected: rhythm.next_expected,
      confidence: rhythm.confidence,
      recurring_note: commonNote(list.map((j) => j.notes)),
      example_journal_ids: list.slice(-3).map((j) => j.journal_id),
    });
  }
  return out.sort((a, b) => b.sample_size - a.sample_size);
}

/** Proposable = enough repeats AND a monthly cadence. */
export function isJournalPatternProposable(p: JournalPattern): boolean {
  return p.sample_size >= MIN_JOURNAL_PATTERN_SAMPLE &&
    (p.cadence === "fixed_recurring" || p.cadence === "variable_recurring");
}
