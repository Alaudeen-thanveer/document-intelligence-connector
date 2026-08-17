/**
 * Bank layer 1: what a statement description usually means.
 * Pure — no I/O.
 *
 * Every categorised bank line in Zoho Books (and every line a reviewer
 * confirms in this app) is an observation: a raw statement description,
 * money in or out, and what the bookkeeper decided it was — which party,
 * which account, and what kind of transaction (customer receipt, vendor
 * payment, expense, deposit, transfer).
 *
 * Statement descriptions are noisy: "POS PURCHASE ETISALAT 044556 DUBAI AE",
 * "INWARD TT ACME RETAIL GRP REF 88213". They are FINGERPRINTED by
 * stripping numbers, references and bank boilerplate, keeping the words
 * that actually identify the counterparty. Observations sharing a
 * fingerprint (and a side) are grouped; the dominant decision in the group
 * becomes the pattern, with a share and a confidence.
 *
 * At suggestion time a new line is matched to patterns by how much of a
 * pattern's fingerprint appears in the line. Nothing is suggested below
 * the confidence gate — the line stays open for the reviewer.
 */

export type BankSide = "debit" | "credit"; // debit = money out, credit = money in
export type BankTxnKind =
  | "customer_payment"
  | "vendor_payment"
  | "expense"
  | "deposit"
  | "transfer"
  | "other";

export interface BankObservation {
  description: string;
  side: BankSide;
  amount: number;
  date: string; // yyyy-mm-dd
  txn_kind: BankTxnKind;
  party_kind: "vendor" | "customer" | null;
  party_zoho_id: string | null;
  party_name: string | null;
  /** The category / offset account (expense account, income account, or the
   *  other bank account on a transfer). Null for payments applied to docs. */
  account_id: string | null;
  account_name: string | null;
  source: "zoho_bank" | "zoho_payment" | "confirmed_line";
}

export interface BankPattern {
  /** Sorted salient tokens joined by a space — the group key. */
  fingerprint: string;
  tokens: string[];
  side: BankSide;
  txn_kind: BankTxnKind;
  party_kind: "vendor" | "customer" | null;
  party_zoho_id: string | null;
  party_name: string | null;
  account_id: string | null;
  account_name: string | null;
  sample_size: number;
  /** Fraction of the group's observations that agree with the dominant
   *  (party, account, kind) tuple. */
  share: number;
  amount_median: number;
  amount_p10: number;
  amount_p90: number;
  first_seen: string;
  last_seen: string;
  /** Up to three raw descriptions, so a reviewer can see what it learned from. */
  examples: string[];
  confidence: number;
}

/** Fewer than this and a fingerprint is noise, not a habit. */
export const MIN_BANK_PATTERN_SAMPLE = 2;
/** Suggestions below this are withheld — the line is left open. */
export const BANK_SUGGEST_MIN_CONFIDENCE = 0.55;

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Bank boilerplate that identifies nothing. Kept deliberately narrow: a
 * word only goes here if it appears on lines for MANY different
 * counterparties. Company-form suffixes (LLC, FZE) stay — they help split
 * "Gulf Trading LLC" from "Gulf Trading FZCO".
 */
const STOP = new Set([
  "POS", "PURCHASE", "PAYMENT", "PYMT", "PMT", "TRANSFER", "TRF", "TT",
  "INWARD", "OUTWARD", "REMITTANCE", "REM", "ONLINE", "MOBILE", "INTERNET",
  "BANKING", "CARD", "DEBIT", "CREDIT", "CHQ", "CHEQUE", "CHECK", "CASH",
  "ATM", "WITHDRAWAL", "DEPOSIT", "REF", "REFERENCE", "NO", "NUM", "ID",
  "TXN", "TRANSACTION", "FROM", "TO", "THE", "OF", "AND", "FOR", "BY", "VIA",
  "AT", "ON", "IN", "AED", "USD", "EUR", "GBP", "INR", "SAR",
  "DUBAI", "ABU", "DHABI", "SHARJAH", "AJMAN", "UAE", "AE", "ARE",
  "LOCAL", "INTL", "INTERNATIONAL", "DOMESTIC", "SWIFT", "IBAN", "NEFT",
  "IMPS", "RTGS", "ACH", "WIRE", "FT", "IPS", "UAEFTS", "FTS",
  "VALUE", "DATE", "DT", "CHARGES", "CHARGE", "FEE", "FEES", "COMMISSION",
  "SALARY", "SAL", "WPS", "MONTHLY", "STANDING", "ORDER", "SO", "DD",
  "AUTO", "AUTOPAY", "AUTOMATIC", "RECURRING",
  "INV", "INVOICE", "INVOICES", "BILL", "BILLS", "RCPT", "RECEIPT", "SETTLEMENT",
]);

/** A token that is mostly digits or looks like a reference/date is noise. */
function isReferenceLike(tok: string): boolean {
  if (/^\d+$/.test(tok)) return true;
  const digits = (tok.match(/\d/g) ?? []).length;
  if (digits >= 3) return true; // POS terminal ids, ref numbers, dates
  if (digits > 0 && tok.length <= 4) return true; // "AE12", "T02"
  return false;
}

/**
 * Normalise a description to its salient tokens: upper-cased, alphabetic
 * words of 2+ letters, minus boilerplate and reference-like tokens.
 * Order-independent (sorted, deduplicated) so "ETISALAT POS" and
 * "POS ETISALAT" fingerprint identically.
 */
export function tokenizeDescription(description: string): string[] {
  const upper = String(description ?? "").toUpperCase();
  const raw = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  const out = new Set<string>();
  for (const t of raw) {
    if (isReferenceLike(t)) continue;
    const alpha = t.replace(/[^A-Z]/g, "");
    if (alpha.length < 2) continue;
    if (STOP.has(alpha)) continue;
    out.add(alpha);
  }
  return [...out].sort();
}

export function fingerprintDescription(description: string): string {
  return tokenizeDescription(description).join(" ");
}

// ---------------------------------------------------------------------------
// Building patterns from observations
// ---------------------------------------------------------------------------

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function decisionKey(o: BankObservation): string {
  return [
    o.txn_kind,
    o.party_kind ?? "",
    o.party_zoho_id ?? "",
    o.account_id ?? "",
  ].join("|");
}

/**
 * Confidence combines evidence volume and agreement, the same way the
 * party→account layer does: share × (1 − 1/(n+1)), so 2 unanimous
 * observations give 0.67, 5 give 0.83, 20 give 0.95; a split group scores
 * lower however large it is.
 */
export function bankPatternConfidence(share: number, n: number): number {
  return Math.round(share * (1 - 1 / (n + 1)) * 100) / 100;
}

export function buildBankPatterns(observations: BankObservation[]): BankPattern[] {
  const groups = new Map<string, BankObservation[]>();
  for (const o of observations) {
    const fp = fingerprintDescription(o.description);
    if (!fp) continue; // nothing identifying left ("CHQ 000123")
    const key = `${o.side}::${fp}`;
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }

  const patterns: BankPattern[] = [];
  for (const [key, list] of groups) {
    if (list.length < MIN_BANK_PATTERN_SAMPLE) continue;
    const side = key.slice(0, key.indexOf("::")) as BankSide;
    const fingerprint = key.slice(key.indexOf("::") + 2);

    // Dominant decision within the group.
    const tally = new Map<string, { n: number; rep: BankObservation }>();
    for (const o of list) {
      const k = decisionKey(o);
      const e = tally.get(k) ?? { n: 0, rep: o };
      e.n++;
      tally.set(k, e);
    }
    let best: { n: number; rep: BankObservation } | null = null;
    for (const e of tally.values()) if (!best || e.n > best.n) best = e;
    if (!best) continue;

    const amounts = list.map((o) => Math.abs(o.amount)).sort((a, b) => a - b);
    const dates = list.map((o) => o.date).filter(Boolean).sort();
    const share = Math.round((best.n / list.length) * 100) / 100;
    const rep = best.rep;
    const examples: string[] = [];
    for (const o of list) {
      const d = o.description.trim();
      if (d && !examples.includes(d)) examples.push(d);
      if (examples.length >= 3) break;
    }

    patterns.push({
      fingerprint,
      tokens: fingerprint.split(" "),
      side,
      txn_kind: rep.txn_kind,
      party_kind: rep.party_kind,
      party_zoho_id: rep.party_zoho_id,
      party_name: rep.party_name,
      account_id: rep.account_id,
      account_name: rep.account_name,
      sample_size: list.length,
      share,
      amount_median: quantile(amounts, 0.5),
      amount_p10: quantile(amounts, 0.1),
      amount_p90: quantile(amounts, 0.9),
      first_seen: dates[0] ?? "",
      last_seen: dates[dates.length - 1] ?? "",
      examples,
      confidence: bankPatternConfidence(share, list.length),
    });
  }
  return patterns.sort((a, b) => b.sample_size - a.sample_size);
}

// ---------------------------------------------------------------------------
// Matching a new line against learned patterns
// ---------------------------------------------------------------------------

export interface BankMatch {
  pattern: BankPattern;
  /** Fraction of the pattern's tokens present in the line. */
  coverage: number;
  /** Final score = coverage × pattern confidence. */
  score: number;
}

/**
 * Best pattern for a line, or null. A pattern qualifies when every one of
 * its tokens appears in the line (coverage 1) or, for patterns of 3+
 * tokens, at least two thirds do. Same side only — money in and money out
 * are different habits even for the same counterparty. Ties break on more
 * specific (longer) fingerprints, then on more evidence.
 */
export function matchBankPattern(
  description: string,
  side: BankSide,
  patterns: BankPattern[],
): BankMatch | null {
  const lineTokens = new Set(tokenizeDescription(description));
  if (!lineTokens.size) return null;
  let best: BankMatch | null = null;
  for (const p of patterns) {
    if (p.side !== side || !p.tokens.length) continue;
    let hit = 0;
    for (const t of p.tokens) if (lineTokens.has(t)) hit++;
    const coverage = hit / p.tokens.length;
    const qualifies = coverage === 1 || (p.tokens.length >= 3 && coverage >= 2 / 3);
    if (!qualifies) continue;
    const score = Math.round(coverage * p.confidence * 100) / 100;
    if (
      !best ||
      score > best.score ||
      (score === best.score && p.tokens.length > best.pattern.tokens.length) ||
      (score === best.score && p.tokens.length === best.pattern.tokens.length &&
        p.sample_size > best.pattern.sample_size)
    ) {
      best = { pattern: p, coverage, score };
    }
  }
  return best;
}

/** Whether a match is strong enough to put in front of a reviewer. */
export function isBankMatchSuggestible(m: BankMatch | null): m is BankMatch {
  return !!m && m.score >= BANK_SUGGEST_MIN_CONFIDENCE;
}
