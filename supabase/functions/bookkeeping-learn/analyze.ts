/**
 * Pure analysis for bookkeeping patterns. No I/O, no Deno APIs — runs
 * identically under Deno (edge function) and Node (tests, accuracy scripts).
 *
 * Layer 1: party → account profiles.
 * See docs/BOOKKEEPING_PATTERNS_SPEC.md §3.1 and §4.
 */

/** A reporting-tag selection on a line: which tag, which option. */
export interface LineTag {
  tag_id: string;
  tag_name: string | null;
  tag_option_id: string;
  tag_option_name: string | null;
}

/** One historical document as the learner consumes it. */
export interface HistoryDoc {
  doc_kind: "bill" | "invoice" | "expense" | "journal";
  zoho_id: string;
  party_zoho_id: string;
  party_name: string;
  date: string;                 // yyyy-mm-dd
  total: number;
  currency: string | null;
  tax_treatment: string | null;
  payment_terms_id: string | null;
  /** Purchase-order / reference presence. */
  has_po: boolean;
  line_items: Array<{
    account_id: string | null;
    account_name: string | null;
    amount: number;
    /** Reporting tags applied to this line (Zoho: line.tags[]). */
    tags?: LineTag[];
    /** Project this line is booked to (Zoho: line.project_id). */
    project_id?: string | null;
    project_name?: string | null;
  }>;
  /** Files attached to the document in Zoho (layer 3). */
  documents?: Array<{ file_name: string | null; file_type: string | null }>;
}

export interface AccountSplitEntry {
  account_id: string;
  account_name: string;
  lines: number;
  share: number;
}

export interface PartyProfile {
  party_kind: "vendor" | "customer";
  party_zoho_id: string;
  party_name: string;
  dominant_account_id: string | null;
  dominant_account_name: string | null;
  account_share: number | null;
  account_split: AccountSplitEntry[];
  tax_treatment: string | null;
  currency: string | null;
  payment_terms_id: string | null;
  po_usually_present: boolean | null;
  amount_median: number | null;
  amount_p10: number | null;
  amount_p90: number | null;
  sample_size: number;
  line_sample_size: number;
  confidence: number;
  first_seen: string | null;
  last_seen: string | null;
}

/** Below this many documents a profile is computed but not proposed. */
export const MIN_SAMPLE_FOR_PROPOSAL = 3;

/** Bills and expenses profile the vendor; invoices the customer;
 * journals have no party. */
export function partyKindForDoc(
  kind: HistoryDoc["doc_kind"],
): "vendor" | "customer" | null {
  if (kind === "bill" || kind === "expense") return "vendor";
  if (kind === "invoice") return "customer";
  return null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mode<T extends string>(values: Array<T | null | undefined>): T | null {
  const counts = new Map<T, number>();
  for (const v of values) {
    if (v == null || v === "") continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: T | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/**
 * Confidence combines how dominant the account is with how much evidence
 * there is. share=1 over 3 docs is weaker than share=0.9 over 40 docs.
 *   confidence = share × (1 − e^(−n/8))
 * n=3 → ×0.31, n=8 → ×0.63, n=20 → ×0.92, n=40 → ×0.99
 */
export function profileConfidence(share: number, sampleSize: number): number {
  if (sampleSize <= 0 || !Number.isFinite(share)) return 0;
  const evidence = 1 - Math.exp(-sampleSize / 8);
  return Math.round(share * evidence * 1000) / 1000;
}

/**
 * Build one profile per party from a set of historical documents.
 * Bills profile vendors; invoices profile customers.
 */
export function buildPartyProfiles(docs: HistoryDoc[]): PartyProfile[] {
  const groups = new Map<string, HistoryDoc[]>();
  for (const d of docs) {
    if (!d.party_zoho_id) continue; // journals have no party
    const kind = partyKindForDoc(d.doc_kind);
    if (!kind) continue;
    const key = `${kind}:${d.party_zoho_id}`;
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }

  const profiles: PartyProfile[] = [];
  for (const [key, list] of groups) {
    const party_kind = key.startsWith("vendor:") ? "vendor" : "customer";

    // Account tally across all lines (by line count; amount-weighted share
    // is also informative but line count is what "which account do they
    // usually pick" means to a reviewer).
    const acct = new Map<string, { name: string; lines: number }>();
    let lineTotal = 0;
    for (const d of list) {
      for (const li of d.line_items) {
        if (!li.account_id) continue;
        const e = acct.get(li.account_id) ?? {
          name: li.account_name ?? "",
          lines: 0,
        };
        e.lines += 1;
        if (!e.name && li.account_name) e.name = li.account_name;
        acct.set(li.account_id, e);
        lineTotal += 1;
      }
    }
    const split: AccountSplitEntry[] = [...acct.entries()]
      .map(([account_id, e]) => ({
        account_id,
        account_name: e.name,
        lines: e.lines,
        share: lineTotal > 0 ? Math.round((e.lines / lineTotal) * 1000) / 1000 : 0,
      }))
      .sort((a, b) => b.lines - a.lines);
    const dominant = split[0] ?? null;

    const totals = list.map((d) => d.total).filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    const dates = list.map((d) => d.date).filter(Boolean).sort();
    const poCount = list.filter((d) => d.has_po).length;

    const sample_size = list.length;
    profiles.push({
      party_kind,
      party_zoho_id: list[0].party_zoho_id,
      party_name: mode(list.map((d) => d.party_name)) ?? list[0].party_name,
      dominant_account_id: dominant?.account_id ?? null,
      dominant_account_name: dominant?.account_name ?? null,
      account_share: dominant?.share ?? null,
      account_split: split,
      tax_treatment: mode(list.map((d) => d.tax_treatment)),
      currency: mode(list.map((d) => d.currency)),
      payment_terms_id: mode(list.map((d) => d.payment_terms_id)),
      po_usually_present: sample_size > 0 ? poCount / sample_size >= 0.5 : null,
      amount_median: percentile(totals, 0.5),
      amount_p10: percentile(totals, 0.1),
      amount_p90: percentile(totals, 0.9),
      sample_size,
      line_sample_size: lineTotal,
      confidence: dominant
        ? profileConfidence(dominant.share, sample_size)
        : 0,
      first_seen: dates[0] ?? null,
      last_seen: dates[dates.length - 1] ?? null,
    });
  }

  return profiles.sort((a, b) => b.sample_size - a.sample_size);
}

/** Whether a profile carries enough evidence to be shown as a proposal. */
export function isProposable(p: PartyProfile): boolean {
  return p.sample_size >= MIN_SAMPLE_FOR_PROPOSAL && !!p.dominant_account_id;
}

/**
 * A "split" party has no clearly dominant account: its lines routinely go
 * to more than one account. Such parties need line-level attention rather
 * than a single default rule.
 */
export function isSplitParty(p: PartyProfile): boolean {
  return (
    p.account_split.length >= 2 &&
    (p.account_share ?? 0) < 0.7 &&
    p.line_sample_size >= MIN_SAMPLE_FOR_PROPOSAL
  );
}
