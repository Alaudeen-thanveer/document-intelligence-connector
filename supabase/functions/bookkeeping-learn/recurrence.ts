/**
 * Layer 2: recurrence cadence per vendor. Pure — no I/O.
 * See docs/BOOKKEEPING_PATTERNS_SPEC.md §3.2.
 *
 * Classifies a party's document series into:
 *   fixed_recurring     monthly, amount within ±2% of median  (rent, subs)
 *   variable_recurring  monthly cadence, amount varies       (utilities)
 *   irregular           no monthly cadence                    (projects)
 *   insufficient        fewer than MIN_SERIES documents
 */

export interface SeriesDoc {
  date: string; // yyyy-mm-dd
  total: number;
}

export type Cadence =
  | "fixed_recurring"
  | "variable_recurring"
  | "irregular"
  | "insufficient";

export interface Rhythm {
  cadence: Cadence;
  /** Distinct calendar months with ≥1 document, over the observed span. */
  months_observed: number;
  months_spanned: number;
  /** Share of spanned months that had a document (1.0 = every month). */
  monthly_coverage: number;
  /** Day-of-month window most documents fall in, e.g. [1, 5]. */
  expected_day_min: number | null;
  expected_day_max: number | null;
  amount_median: number | null;
  amount_p10: number | null;
  amount_p90: number | null;
  /** Coefficient of variation of amounts (stdev / mean). */
  amount_cv: number | null;
  sample_size: number;
  last_seen: string | null;
  /** First day of the month after last_seen — when the next is expected. */
  next_expected: string | null;
  confidence: number;
}

export const MIN_SERIES = 4;
/** Coverage above this = "monthly". Allows a missed month or two. */
const MONTHLY_COVERAGE_MIN = 0.75;
/** Amount CV below this with monthly cadence = fixed. */
const FIXED_CV_MAX = 0.02;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function monthKey(date: string): string {
  return date.slice(0, 7); // yyyy-mm
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am) + 1;
}

export function classifyRhythm(docs: SeriesDoc[]): Rhythm {
  const clean = docs
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && Number.isFinite(d.total))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sample_size = clean.length;
  const totals = clean.map((d) => d.total).sort((a, b) => a - b);
  const median = percentile(totals, 0.5);
  const p10 = percentile(totals, 0.1);
  const p90 = percentile(totals, 0.9);
  const mean = totals.length
    ? totals.reduce((s, n) => s + n, 0) / totals.length
    : 0;
  const stdev = totals.length > 1
    ? Math.sqrt(
      totals.reduce((s, n) => s + (n - mean) ** 2, 0) / (totals.length - 1),
    )
    : 0;
  const cv = mean > 0 && totals.length > 1 ? stdev / mean : null;
  const last = clean[clean.length - 1]?.date ?? null;

  const base: Omit<Rhythm, "cadence" | "confidence"> = {
    months_observed: 0,
    months_spanned: 0,
    monthly_coverage: 0,
    expected_day_min: null,
    expected_day_max: null,
    amount_median: median,
    amount_p10: p10,
    amount_p90: p90,
    amount_cv: cv != null ? Math.round(cv * 1000) / 1000 : null,
    sample_size,
    last_seen: last,
    next_expected: null,
  };

  if (sample_size < MIN_SERIES) {
    return { ...base, cadence: "insufficient", confidence: 0 };
  }

  const months = new Set(clean.map((d) => monthKey(d.date)));
  const spanned = monthsBetween(monthKey(clean[0].date), monthKey(last!));
  const coverage = spanned > 0 ? months.size / spanned : 0;

  const days = clean.map((d) => Number(d.date.slice(8, 10)))
    .sort((a, b) => a - b);
  const dayMin = percentile(days, 0.1);
  const dayMax = percentile(days, 0.9);

  const isMonthly = coverage >= MONTHLY_COVERAGE_MIN && months.size >= MIN_SERIES;
  let cadence: Cadence;
  if (!isMonthly) cadence = "irregular";
  else if (cv != null && cv <= FIXED_CV_MAX) cadence = "fixed_recurring";
  else cadence = "variable_recurring";

  // Next expected: first day of the month after last_seen (only meaningful
  // for monthly cadences).
  let next: string | null = null;
  if (isMonthly && last) {
    const [y, m] = last.split("-").map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    next = `${ny}-${String(nm).padStart(2, "0")}-01`;
  }

  // Confidence: coverage × evidence(n). Irregular series get low confidence
  // in the *classification*, not in the amount stats.
  const evidence = 1 - Math.exp(-sample_size / 8);
  const confidence = Math.round(
    (isMonthly ? coverage : 1 - coverage) * evidence * 1000,
  ) / 1000;

  return {
    ...base,
    cadence,
    months_observed: months.size,
    months_spanned: spanned,
    monthly_coverage: Math.round(coverage * 1000) / 1000,
    expected_day_min: dayMin != null ? Math.round(dayMin) : null,
    expected_day_max: dayMax != null ? Math.round(dayMax) : null,
    next_expected: next,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Checks a rhythm can PROPOSE (never auto-enabled).
// ---------------------------------------------------------------------------

export interface CheckProposal {
  check_kind: "recurring_twice_in_period" | "amount_anomaly" | "expected_missing";
  rationale: string;
  params: Record<string, unknown>;
}

/**
 * Which per-vendor checks a rhythm justifies. Returned as proposals; the
 * judgment engine ignores them until a human enables each one.
 */
export function proposeChecks(r: Rhythm): CheckProposal[] {
  const out: CheckProposal[] = [];
  if (r.cadence === "insufficient" || r.cadence === "irregular") return out;

  out.push({
    check_kind: "recurring_twice_in_period",
    rationale:
      `${r.cadence.replace("_", " ")} — a second bill in the same month is ` +
      `suspicious even at a different amount (${r.months_observed}/${r.months_spanned} months covered).`,
    params: { period: "month" },
  });

  if (r.amount_p90 != null && r.amount_median != null) {
    // Fixed: tight band around the median. Variable: outside p10–p90 × 3.
    const params = r.cadence === "fixed_recurring"
      ? { kind: "fixed", median: r.amount_median, tolerance_pct: 5 }
      : { kind: "variable", p10: r.amount_p10, p90: r.amount_p90, multiplier: 3 };
    out.push({
      check_kind: "amount_anomaly",
      rationale: r.cadence === "fixed_recurring"
        ? `amount is always ~${r.amount_median} (cv ${r.amount_cv}); flag if it moves more than 5%.`
        : `amount ranges ${r.amount_p10}–${r.amount_p90}; flag beyond 3× that band.`,
      params,
    });
  }

  if (r.next_expected) {
    out.push({
      check_kind: "expected_missing",
      rationale:
        `arrives every month (days ${r.expected_day_min}–${r.expected_day_max}); ` +
        `nudge at period end if the next one (${r.next_expected}) has not arrived.`,
      params: {
        next_expected: r.next_expected,
        day_min: r.expected_day_min,
        day_max: r.expected_day_max,
      },
    });
  }
  return out;
}
