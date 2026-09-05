/**
 * Layer 3: attachment conventions per party. Pure — no I/O.
 * See docs/BOOKKEEPING_PATTERNS_SPEC.md §3.5.
 *
 * From each historical bill's attached documents, learn how many files a
 * party's bills usually carry and of what kinds, then propose how strict
 * the `missing_supporting_document` check should be for that party.
 */

export interface AttachmentDoc {
  file_name: string | null;
  file_type: string | null;
}

export interface AttachmentHistoryDoc {
  documents: AttachmentDoc[];
}

export type Strictness = "strict" | "standard" | "relaxed";

export interface AttachmentConvention {
  /** Mode of attachment count across the party's bills. */
  count_mode: number;
  /** Share of bills whose count equals the mode. */
  count_mode_share: number;
  /** Share of bills with at least one attachment. */
  attached_share: number;
  /** Share of bills with ≥ 2 attachments. */
  multi_share: number;
  /** File-type distribution, e.g. { pdf: 0.9, jpg: 0.1 }. */
  types: Record<string, number>;
  /** Names that recur (delivery note, PO, GRN…), lowercased tokens. */
  recurring_name_tokens: string[];
  sample_size: number;
  confidence: number;
  /** Proposed strictness for missing_supporting_document. */
  proposed_strictness: Strictness;
  rationale: string;
}

export const MIN_ATTACH_SAMPLE = 3;

/** Tokens that suggest a supporting document beyond the invoice itself. */
const SUPPORT_TOKENS = [
  "delivery",
  "dn",
  "grn",
  "po",
  "purchase",
  "order",
  "packing",
  "receipt",
  "timesheet",
  "contract",
  "statement",
];

function extOf(doc: AttachmentDoc): string {
  const t = (doc.file_type ?? "").toLowerCase().trim();
  if (t) return t;
  const m = (doc.file_name ?? "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return m ? m[1] : "unknown";
}

function nameTokens(doc: AttachmentDoc): string[] {
  return (doc.file_name ?? "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

export function learnAttachmentConvention(
  bills: AttachmentHistoryDoc[],
): AttachmentConvention {
  const n = bills.length;
  const counts = bills.map((b) => b.documents.length);

  const countTally = new Map<number, number>();
  for (const c of counts) countTally.set(c, (countTally.get(c) ?? 0) + 1);
  let count_mode = 0;
  let modeN = 0;
  for (const [c, k] of countTally) {
    if (k > modeN || (k === modeN && c > count_mode)) {
      count_mode = c;
      modeN = k;
    }
  }

  const attached = counts.filter((c) => c >= 1).length;
  const multi = counts.filter((c) => c >= 2).length;

  const typeTally = new Map<string, number>();
  const tokenTally = new Map<string, number>();
  let totalDocs = 0;
  for (const b of bills) {
    const seenTokensThisBill = new Set<string>();
    for (const d of b.documents) {
      totalDocs++;
      const ext = extOf(d);
      typeTally.set(ext, (typeTally.get(ext) ?? 0) + 1);
      for (const t of nameTokens(d)) {
        if (SUPPORT_TOKENS.includes(t) && !seenTokensThisBill.has(t)) {
          tokenTally.set(t, (tokenTally.get(t) ?? 0) + 1);
          seenTokensThisBill.add(t);
        }
      }
    }
  }
  const types: Record<string, number> = {};
  for (const [ext, k] of typeTally) {
    types[ext] = totalDocs > 0 ? Math.round((k / totalDocs) * 1000) / 1000 : 0;
  }
  // A token is "recurring" if it appears on ≥ 50% of bills.
  const recurring_name_tokens = [...tokenTally.entries()]
    .filter(([, k]) => n > 0 && k / n >= 0.5)
    .map(([t]) => t)
    .sort();

  const attached_share = n > 0 ? attached / n : 0;
  const multi_share = n > 0 ? multi / n : 0;
  const count_mode_share = n > 0 ? modeN / n : 0;
  const evidence = 1 - Math.exp(-n / 8);
  const confidence = Math.round(count_mode_share * evidence * 1000) / 1000;

  let proposed_strictness: Strictness;
  let rationale: string;
  if (n < MIN_ATTACH_SAMPLE) {
    proposed_strictness = "standard";
    rationale = `only ${n} bill(s) — not enough history; keep the standard check.`;
  } else if (multi_share >= 0.7 || recurring_name_tokens.length > 0) {
    proposed_strictness = "strict";
    rationale = recurring_name_tokens.length > 0
      ? `bills usually carry a ${recurring_name_tokens.join("/")} in addition to the invoice ` +
        `(${Math.round(multi_share * 100)}% have 2+ files); require it.`
      : `${Math.round(multi_share * 100)}% of bills carry 2+ files; require a supporting document.`;
  } else if (attached_share <= 0.2) {
    proposed_strictness = "relaxed";
    rationale =
      `${Math.round((1 - attached_share) * 100)}% of bills have no attachment at all ` +
      `(likely entered from a statement); do not fail review for a missing one.`;
  } else {
    proposed_strictness = "standard";
    rationale = `${Math.round(attached_share * 100)}% of bills carry exactly the invoice; keep the standard check.`;
  }

  return {
    count_mode,
    count_mode_share: Math.round(count_mode_share * 1000) / 1000,
    attached_share: Math.round(attached_share * 1000) / 1000,
    multi_share: Math.round(multi_share * 1000) / 1000,
    types,
    recurring_name_tokens,
    sample_size: n,
    confidence,
    proposed_strictness,
    rationale,
  };
}
