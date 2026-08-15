/**
 * Layer 4: reporting tags and projects per party. Pure — no I/O.
 *
 * Learns, per vendor/customer, which reporting-tag option is usually
 * applied per tag, and which project lines are usually booked to, across
 * bills, invoices, expenses (vendor) and journals (no party — learned per
 * account instead, see learnJournalTagUsage). Everything here is a
 * proposal: it prefills at review time only after a human accepts it.
 */
import type { HistoryDoc, LineTag } from "./analyze.ts";

export const MIN_TAG_SAMPLE = 3;

export interface TagUsage {
  tag_id: string;
  tag_name: string | null;
  /** Dominant option for this tag. */
  option_id: string;
  option_name: string | null;
  /** Share of this party's tagged lines (for this tag) using the option. */
  share: number;
  /** Lines carrying this tag at all. */
  lines: number;
  confidence: number;
}

export interface ProjectUsage {
  project_id: string;
  project_name: string | null;
  /** Share of this party's lines booked to this project. */
  share: number;
  lines: number;
  confidence: number;
}

export interface PartyTagProfile {
  party_kind: "vendor" | "customer";
  party_zoho_id: string;
  party_name: string;
  /** One entry per tag the party's lines carry. */
  tags: TagUsage[];
  /** Dominant project, if lines are usually booked to one. */
  project: ProjectUsage | null;
  /** Share of lines with ANY project. */
  project_share: number;
  line_sample_size: number;
  doc_sample_size: number;
}

function evidence(n: number): number {
  return 1 - Math.exp(-n / 8);
}

function partyKindOf(kind: HistoryDoc["doc_kind"]): "vendor" | "customer" | null {
  if (kind === "bill" || kind === "expense") return "vendor";
  if (kind === "invoice") return "customer";
  return null; // journals have no party
}

/** Per-party tag + project usage across bills, invoices and expenses. */
export function learnPartyTagProfiles(docs: HistoryDoc[]): PartyTagProfile[] {
  const groups = new Map<string, HistoryDoc[]>();
  for (const d of docs) {
    const kind = partyKindOf(d.doc_kind);
    if (!kind || !d.party_zoho_id) continue;
    const key = `${kind}:${d.party_zoho_id}`;
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }

  const out: PartyTagProfile[] = [];
  for (const [key, list] of groups) {
    const party_kind = key.startsWith("vendor:") ? "vendor" : "customer";
    // tag_id → option_id → count
    const tagTally = new Map<string, { name: string | null; options: Map<string, { name: string | null; n: number }>; lines: number }>();
    const projTally = new Map<string, { name: string | null; n: number }>();
    let lineTotal = 0;
    let projLines = 0;

    for (const d of list) {
      for (const li of d.line_items) {
        lineTotal++;
        for (const t of li.tags ?? []) {
          if (!t.tag_id || !t.tag_option_id) continue;
          const e = tagTally.get(t.tag_id) ?? { name: t.tag_name, options: new Map(), lines: 0 };
          e.lines++;
          if (!e.name && t.tag_name) e.name = t.tag_name;
          const o = e.options.get(t.tag_option_id) ?? { name: t.tag_option_name, n: 0 };
          o.n++;
          if (!o.name && t.tag_option_name) o.name = t.tag_option_name;
          e.options.set(t.tag_option_id, o);
          tagTally.set(t.tag_id, e);
        }
        if (li.project_id) {
          projLines++;
          const p = projTally.get(li.project_id) ?? { name: li.project_name ?? null, n: 0 };
          p.n++;
          if (!p.name && li.project_name) p.name = li.project_name;
          projTally.set(li.project_id, p);
        }
      }
    }

    const tags: TagUsage[] = [];
    for (const [tag_id, e] of tagTally) {
      let best: { id: string; name: string | null; n: number } | null = null;
      for (const [id, o] of e.options) {
        if (!best || o.n > best.n) best = { id, name: o.name, n: o.n };
      }
      if (!best) continue;
      const share = e.lines > 0 ? best.n / e.lines : 0;
      tags.push({
        tag_id,
        tag_name: e.name,
        option_id: best.id,
        option_name: best.name,
        share: Math.round(share * 1000) / 1000,
        lines: e.lines,
        confidence: Math.round(share * evidence(e.lines) * 1000) / 1000,
      });
    }
    tags.sort((a, b) => b.lines - a.lines);

    let project: ProjectUsage | null = null;
    let bestP: { id: string; name: string | null; n: number } | null = null;
    for (const [id, p] of projTally) {
      if (!bestP || p.n > bestP.n) bestP = { id, name: p.name, n: p.n };
    }
    if (bestP && lineTotal > 0) {
      const share = bestP.n / lineTotal;
      project = {
        project_id: bestP.id,
        project_name: bestP.name,
        share: Math.round(share * 1000) / 1000,
        lines: bestP.n,
        confidence: Math.round(share * evidence(bestP.n) * 1000) / 1000,
      };
    }

    out.push({
      party_kind,
      party_zoho_id: list[0].party_zoho_id,
      party_name: list[0].party_name,
      tags,
      project,
      project_share: lineTotal > 0 ? Math.round((projLines / lineTotal) * 1000) / 1000 : 0,
      line_sample_size: lineTotal,
      doc_sample_size: list.length,
    });
  }
  return out.sort((a, b) => b.doc_sample_size - a.doc_sample_size);
}

/** A tag usage is proposable when its lines ≥ MIN and the option is dominant. */
export function isTagProposable(t: TagUsage): boolean {
  return t.lines >= MIN_TAG_SAMPLE && t.share >= 0.7;
}
export function isProjectProposable(p: ProjectUsage | null, lineSample: number): boolean {
  return !!p && p.lines >= MIN_TAG_SAMPLE && lineSample > 0 && p.share >= 0.7;
}

// ---------------------------------------------------------------------------
// Journals have no party. Learn tag usage per ACCOUNT instead — "lines on
// Depreciation Expense are tagged Department=Admin".
// ---------------------------------------------------------------------------
export interface AccountTagUsage {
  account_id: string;
  account_name: string | null;
  tag_id: string;
  tag_name: string | null;
  option_id: string;
  option_name: string | null;
  share: number;
  lines: number;
  confidence: number;
}

export function learnJournalTagUsage(docs: HistoryDoc[]): AccountTagUsage[] {
  // account_id → tag_id → option_id → n
  const tally = new Map<string, { name: string | null; tags: Map<string, { name: string | null; options: Map<string, { name: string | null; n: number }>; lines: number }> }>();
  for (const d of docs) {
    if (d.doc_kind !== "journal") continue;
    for (const li of d.line_items) {
      if (!li.account_id) continue;
      const a = tally.get(li.account_id) ?? { name: li.account_name, tags: new Map() };
      if (!a.name && li.account_name) a.name = li.account_name;
      for (const t of li.tags ?? []) {
        if (!t.tag_id || !t.tag_option_id) continue;
        const e = a.tags.get(t.tag_id) ?? { name: t.tag_name, options: new Map(), lines: 0 };
        e.lines++;
        const o = e.options.get(t.tag_option_id) ?? { name: t.tag_option_name, n: 0 };
        o.n++;
        e.options.set(t.tag_option_id, o);
        a.tags.set(t.tag_id, e);
      }
      tally.set(li.account_id, a);
    }
  }
  const out: AccountTagUsage[] = [];
  for (const [account_id, a] of tally) {
    for (const [tag_id, e] of a.tags) {
      let best: { id: string; name: string | null; n: number } | null = null;
      for (const [id, o] of e.options) {
        if (!best || o.n > best.n) best = { id, name: o.name, n: o.n };
      }
      if (!best) continue;
      const share = e.lines > 0 ? best.n / e.lines : 0;
      out.push({
        account_id,
        account_name: a.name,
        tag_id,
        tag_name: e.name,
        option_id: best.id,
        option_name: best.name,
        share: Math.round(share * 1000) / 1000,
        lines: e.lines,
        confidence: Math.round(share * evidence(e.lines) * 1000) / 1000,
      });
    }
  }
  return out.sort((a, b) => b.lines - a.lines);
}

/** Convert a Zoho line's tags[] into LineTag[] (shared by every doc kind). */
export function parseZohoLineTags(raw: unknown): LineTag[] {
  if (!Array.isArray(raw)) return [];
  const out: LineTag[] = [];
  for (const t of raw as Array<Record<string, unknown>>) {
    const tag_id = t.tag_id != null ? String(t.tag_id) : "";
    const tag_option_id = t.tag_option_id != null ? String(t.tag_option_id) : "";
    if (!tag_id || !tag_option_id) continue;
    out.push({
      tag_id,
      tag_name: t.tag_name != null ? String(t.tag_name) : null,
      tag_option_id,
      tag_option_name: t.tag_option_name != null ? String(t.tag_option_name) : null,
    });
  }
  return out;
}
