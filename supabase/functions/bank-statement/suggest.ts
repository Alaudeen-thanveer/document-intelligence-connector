/**
 * Bank layer 3: what to suggest for each statement line — or nothing.
 *
 * `suggestForLines` is pure. It combines, in order of trust:
 *   1. an OPEN DOCUMENT match — money in that equals an unpaid invoice's
 *      balance (or names its number / customer) → customer receipt applied
 *      to that invoice; money out matching an unpaid bill → vendor payment
 *      applied to that bill;
 *   2. a LEARNED PATTERN for the description (bank layer 1) → the party,
 *      account and kind the bookkeeper usually chose;
 *   3. a PARTY NAME appearing in the description with no other evidence
 *      → the party only, kind by side, account left blank.
 * A line that matches nothing well enough gets NO suggestion — it stays
 * open for the reviewer to fill. Suggestions are proposals; nothing is
 * posted until confirmed.
 *
 * `fetchOpenDocuments` is the one piece of I/O: it reads unpaid invoices
 * and bills from Zoho through the metered fetch.
 */
import {
  type BankPattern,
  BANK_SUGGEST_MIN_CONFIDENCE,
  isBankMatchSuggestible,
  matchBankPattern,
  tokenizeDescription,
} from "../bookkeeping-learn/bank_patterns.ts";

export interface LineForSuggest {
  line_no: number;
  txn_date: string;
  description: string;
  reference: string | null;
  side: "debit" | "credit";
  amount: number;
}

export interface OpenDoc {
  kind: "invoice" | "bill";
  zoho_id: string;
  number: string;
  party_zoho_id: string;
  party_name: string;
  date: string;
  due_date: string | null;
  total: number;
  balance: number;
  currency: string | null;
}

export interface PartyRef {
  kind: "vendor" | "customer";
  zoho_id: string;
  name: string;
}

export interface Suggestion {
  txn_kind: "customer_payment" | "vendor_payment" | "expense" | "deposit" | "transfer" | "other";
  party_kind: "vendor" | "customer" | null;
  party_zoho_id: string | null;
  party_name: string | null;
  account_id: string | null;
  account_name: string | null;
  doc_kind: "invoice" | "bill" | null;
  doc_zoho_id: string | null;
  doc_number: string | null;
  doc_balance: number | null;
  confidence: number;
  source: "open_document" | "learned" | "accepted_rule" | "party_name";
  reason: string;
}

/** Amount tolerance for "equals the balance": bank charges shave a few fils. */
export const AMOUNT_TOLERANCE = 0.05;

// ---------------------------------------------------------------------------
// Open document matching
// ---------------------------------------------------------------------------

function normalizeNumber(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** How well a doc fits a line: number in text > amount+party > amount alone. */
function scoreDoc(line: LineForSuggest, doc: OpenDoc, partyTokens: Set<string>): { score: number; reason: string } | null {
  const text = `${line.description} ${line.reference ?? ""}`.toUpperCase();
  const textNorm = normalizeNumber(text);
  const numNorm = normalizeNumber(doc.number);
  const numberInText = numNorm.length >= 4 && textNorm.includes(numNorm);
  const amountMatches = Math.abs(line.amount - doc.balance) <= AMOUNT_TOLERANCE;
  const partyNamed = [...partyTokens].filter((t) => t.length >= 3).some((t) => text.split(/[^A-Z0-9]+/).includes(t));

  if (numberInText && amountMatches) return { score: 0.98, reason: `${doc.number} named in the line and ${fmt(doc.balance)} equals its balance` };
  if (numberInText) return { score: 0.85, reason: `${doc.number} is named in the line (balance ${fmt(doc.balance)}, line ${fmt(line.amount)})` };
  if (amountMatches && partyNamed) return { score: 0.9, reason: `${fmt(line.amount)} equals the open balance of ${doc.number} and ${doc.party_name} appears in the line` };
  if (amountMatches) return { score: 0.7, reason: `${fmt(line.amount)} equals the open balance of ${doc.number} (${doc.party_name})` };
  return null;
}
function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Party name in the description
// ---------------------------------------------------------------------------

function partyInText(line: LineForSuggest, parties: PartyRef[]): { party: PartyRef; score: number } | null {
  const lineTokens = new Set(tokenizeDescription(`${line.description} ${line.reference ?? ""}`));
  if (!lineTokens.size) return null;
  let best: { party: PartyRef; score: number } | null = null;
  for (const p of parties) {
    const pt = tokenizeDescription(p.name);
    if (!pt.length) continue;
    const hit = pt.filter((t) => lineTokens.has(t)).length;
    // Require every distinctive token of a short name, or ≥2 tokens for
    // longer ones — a lone "GULF" must not pick Gulf Trading over Gulf Consulting.
    const ok = pt.length === 1 ? hit === 1 && pt[0].length >= 5 : hit >= Math.max(2, Math.ceil(pt.length * 0.6));
    if (!ok) continue;
    const score = Math.round((hit / pt.length) * 100) / 100;
    if (!best || score > best.score || (score === best.score && pt.length > tokenizeDescription(best.party.name).length)) best = { party: p, score };
  }
  return best;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function suggestForLines(
  lines: LineForSuggest[],
  ctx: { patterns: BankPattern[]; parties: PartyRef[]; openDocs: OpenDoc[] },
): Array<Suggestion | null> {
  const used = new Set<string>(); // an open doc settles at most one line per statement
  const out: Array<Suggestion | null> = [];
  const partyById = new Map(ctx.parties.map((p) => [`${p.kind}:${p.zoho_id}`, p]));

  for (const line of lines) {
    // 1. Open documents — invoices for money in, bills for money out.
    const wantKind = line.side === "credit" ? "invoice" : "bill";
    let bestDoc: { doc: OpenDoc; score: number; reason: string } | null = null;
    for (const doc of ctx.openDocs) {
      if (doc.kind !== wantKind || used.has(doc.zoho_id) || doc.balance <= 0) continue;
      const pk = wantKind === "invoice" ? "customer" : "vendor";
      const p = partyById.get(`${pk}:${doc.party_zoho_id}`);
      const s = scoreDoc(line, doc, new Set(tokenizeDescription(p?.name ?? doc.party_name)));
      if (s && (!bestDoc || s.score > bestDoc.score)) bestDoc = { doc, ...s };
    }
    // Amount-only matches are ambiguous when two open docs share a balance;
    // only trust one if it is the sole candidate at that amount.
    if (bestDoc && bestDoc.score === 0.7) {
      const sameAmount = ctx.openDocs.filter((d) => d.kind === wantKind && !used.has(d.zoho_id) && Math.abs(d.balance - line.amount) <= AMOUNT_TOLERANCE);
      if (sameAmount.length > 1) bestDoc = null;
    }
    if (bestDoc && bestDoc.score >= BANK_SUGGEST_MIN_CONFIDENCE) {
      used.add(bestDoc.doc.zoho_id);
      const isInv = bestDoc.doc.kind === "invoice";
      out.push({
        txn_kind: isInv ? "customer_payment" : "vendor_payment",
        party_kind: isInv ? "customer" : "vendor",
        party_zoho_id: bestDoc.doc.party_zoho_id,
        party_name: bestDoc.doc.party_name,
        account_id: null, account_name: null,
        doc_kind: bestDoc.doc.kind, doc_zoho_id: bestDoc.doc.zoho_id, doc_number: bestDoc.doc.number, doc_balance: bestDoc.doc.balance,
        confidence: bestDoc.score, source: "open_document", reason: bestDoc.reason,
      });
      continue;
    }

    // 2. Learned pattern.
    const m = matchBankPattern(line.description, line.side, ctx.patterns);
    if (isBankMatchSuggestible(m)) {
      const p = m.pattern as BankPattern & { suggestion_status?: string };
      const accepted = p.suggestion_status === "accepted";
      const party = p.party_kind && p.party_zoho_id ? partyById.get(`${p.party_kind}:${p.party_zoho_id}`) : null;
      out.push({
        txn_kind: p.txn_kind,
        party_kind: p.party_kind,
        party_zoho_id: p.party_zoho_id,
        party_name: party?.name ?? p.party_name,
        account_id: p.account_id, account_name: p.account_name,
        doc_kind: null, doc_zoho_id: null, doc_number: null, doc_balance: null,
        confidence: m.score,
        source: accepted ? "accepted_rule" : "learned",
        reason: `${p.sample_size} earlier line${p.sample_size === 1 ? "" : "s"} like “${p.examples[0] ?? p.fingerprint}” were ${describe(p)}` +
          (p.share < 1 ? ` (${Math.round(p.share * 100)}% of the time)` : ""),
      });
      continue;
    }

    // 3. Party name only.
    const pn = partyInText(line, ctx.parties);
    if (pn && pn.score >= 0.6) {
      const isCustomer = pn.party.kind === "customer";
      out.push({
        txn_kind: line.side === "credit" ? (isCustomer ? "customer_payment" : "deposit") : (isCustomer ? "other" : "vendor_payment"),
        party_kind: pn.party.kind, party_zoho_id: pn.party.zoho_id, party_name: pn.party.name,
        account_id: null, account_name: null,
        doc_kind: null, doc_zoho_id: null, doc_number: null, doc_balance: null,
        confidence: Math.round(pn.score * 0.6 * 100) / 100, // name alone is weak evidence
        source: "party_name",
        reason: `“${pn.party.name}” appears in the line; no open ${line.side === "credit" ? "invoice" : "bill"} matches and nothing learned yet`,
      });
      continue;
    }

    out.push(null); // nothing suggestible — leave it open
  }
  return out;
}

function describe(p: BankPattern): string {
  const who = p.party_name ? ` for ${p.party_name}` : "";
  switch (p.txn_kind) {
    case "customer_payment": return `customer receipts${who}`;
    case "vendor_payment": return `vendor payments${who}`;
    case "expense": return `booked to ${p.account_name ?? "an expense account"}${who}`;
    case "deposit": return `booked as deposits to ${p.account_name ?? "an income account"}${who}`;
    case "transfer": return `transfers to ${p.account_name ?? "another account"}`;
    default: return `categorised${who}`;
  }
}

// ---------------------------------------------------------------------------
// I/O: open invoices and bills from Zoho (metered fetch)
// ---------------------------------------------------------------------------

export async function fetchOpenDocuments(
  zohoFetch: typeof fetch, apiBase: string, orgId: string, token: string,
): Promise<OpenDoc[]> {
  const out = new Map<string, OpenDoc>();
  for (const [path, kind, key, idKey, numKey, partyId, partyName] of [
    ["invoices", "invoice", "invoices", "invoice_id", "invoice_number", "customer_id", "customer_name"],
    ["bills", "bill", "bills", "bill_id", "bill_number", "vendor_id", "vendor_name"],
  ] as const) {
    for (const status of ["unpaid", "partially_paid", "overdue"]) {
      let page = 1;
      while (page <= 10) {
        const qs = new URLSearchParams({ organization_id: orgId, status, per_page: "200", page: String(page) });
        const res = await zohoFetch(`${apiBase}/${path}?${qs}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) break; // a status value this org's plan rejects — move on
        for (const d of (j[key] as Array<Record<string, unknown>>) ?? []) {
          const id = String(d[idKey] ?? "");
          if (!id || out.has(id)) continue;
          out.set(id, {
            kind, zoho_id: id, number: String(d[numKey] ?? ""),
            party_zoho_id: String(d[partyId] ?? ""), party_name: String(d[partyName] ?? ""),
            date: String(d.date ?? "").slice(0, 10), due_date: d.due_date ? String(d.due_date).slice(0, 10) : null,
            total: Number(d.total ?? 0) || 0, balance: Number(d.balance ?? 0) || 0,
            currency: d.currency_code != null ? String(d.currency_code) : null,
          });
        }
        if (!(j as { page_context?: { has_more_page?: boolean } }).page_context?.has_more_page) break;
        page++;
      }
    }
  }
  return [...out.values()].filter((d) => d.balance > 0);
}
