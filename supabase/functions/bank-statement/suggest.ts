/**
 * Bank layer 3 + phase 1: what to suggest for each statement line — or
 * nothing.
 *
 * `suggestForLines` is pure. For every line, in order:
 *   0. ALREADY RECORDED — a payment/expense this app already posted for the
 *      same party (or same description) and amount within the company's
 *      day window → "link it, don't create it". Only our own posts are
 *      checked; Zoho is not queried for this. Kills duplicate payments.
 *   1. REFUND — money OUT to a customer that equals one of their open
 *      credit notes or unused payments → credit-note / payment refund;
 *      money IN from a vendor that equals an open vendor credit or unused
 *      vendor payment → vendor-credit / vendor-payment refund.
 *   2. RETAINER — money in equal to (or naming) an open retainer invoice.
 *   3. OPEN DOCUMENTS — money in against unpaid invoices, money out against
 *      unpaid bills. Allocation:
 *        • documents named in the line first, else exact subset-sum, else
 *          oldest-due-first (FIFO);
 *        • short by ≤ bank-charge tolerance (per currency) → full settle,
 *          difference as bank charges;
 *        • short by more → partial; the balance stays open, and if the
 *          company's write-off policy is set and the residual qualifies →
 *          write-off proposed alongside;
 *        • over → allocate what is owed, remainder proposed as an ADVANCE
 *          (unused credit on the party); never forced onto a document.
 *   4. LEARNED PATTERN for the description (bank layer 1).
 *   5. PARTY NAME in the line with nothing else → advance / on-account.
 * Anything else stays open. Every suggestion carries a reason.
 *
 * `fetchOpenDocuments` and `fetchOpenCredits` are the I/O: unpaid
 * invoices/bills, retainer invoices, credit notes, vendor credits and
 * unused payments from Zoho through the metered fetch.
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
  kind: "invoice" | "bill" | "retainer";
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

/** An open credit or unused payment that a refund could relate to. */
export interface OpenCredit {
  kind: "creditnote" | "vendorcredit" | "customerpayment" | "vendorpayment";
  zoho_id: string;
  number: string;
  party_kind: "customer" | "vendor";
  party_zoho_id: string;
  party_name: string;
  date: string;
  balance: number; // unapplied / unused amount
}

export interface PartyRef {
  kind: "vendor" | "customer";
  zoho_id: string;
  name: string;
}

/** A payment or expense this app already posted (bank lines or documents). */
export interface RecordedPost {
  kind: "customer_payment" | "vendor_payment" | "expense" | "other";
  zoho_id: string;
  ref_kind: "customerpayment" | "vendorpayment" | "expense" | "banktransaction";
  party_kind: "vendor" | "customer" | null;
  party_zoho_id: string | null;
  party_name: string | null;
  amount: number;
  date: string;
  side: "debit" | "credit";
  description: string | null;
  source: string; // e.g. "statement line 6 (ENBD Aug)" or "bill dd0001"
}

export interface Policies {
  already_recorded_window_days: number;
  /** currency → absolute tolerance */
  bank_charge_tolerance: Record<string, number>;
  writeoff_after_days: number | null;
  writeoff_max_amount: number | null;
}
export const DEFAULT_POLICIES: Policies = {
  already_recorded_window_days: 3,
  bank_charge_tolerance: { AED: 5, USD: 13 },
  writeoff_after_days: null,
  writeoff_max_amount: null,
};

export type SuggestKind =
  | "customer_payment" | "vendor_payment" | "expense" | "deposit" | "transfer" | "other"
  | "already_recorded" | "retainer_receipt"
  | "creditnote_refund" | "payment_refund" | "vendorcredit_refund" | "vendorpayment_refund";

export interface Allocation {
  doc_kind: "invoice" | "bill" | "retainer";
  doc_zoho_id: string;
  doc_number: string;
  amount_applied: number;
  balance: number;
  due_date: string | null;
}

export interface Suggestion {
  txn_kind: SuggestKind;
  party_kind: "vendor" | "customer" | null;
  party_zoho_id: string | null;
  party_name: string | null;
  account_id: string | null;
  account_name: string | null;
  /** Kept for single-document compatibility; equals allocations[0]. */
  doc_kind: "invoice" | "bill" | "retainer" | null;
  doc_zoho_id: string | null;
  doc_number: string | null;
  doc_balance: number | null;
  /** Full split across documents; sum ≤ line amount. */
  allocations: Allocation[];
  /** Line amount not applied to any document → unused credit (advance). */
  advance_amount: number;
  /** Receipt short by this much, treated as bank charges (customer payments
   *  carry it natively; vendor-side overpay becomes a bank-charge expense). */
  bank_charges: number;
  /** After this line, what would still be open on the (first) document. */
  residual: number;
  /** Write-off of the residual proposed under the company's policy. */
  writeoff: { doc_kind: "invoice" | "bill"; doc_zoho_id: string; doc_number: string; amount: number; reason: string } | null;
  /** For already_recorded and refunds: the existing Zoho record. */
  ref_kind: "customerpayment" | "vendorpayment" | "expense" | "banktransaction" | "creditnote" | "vendorcredit" | "retainerinvoice" | null;
  ref_zoho_id: string | null;
  ref_number: string | null;
  /** All open documents of the identified party — so the reviewer can
   *  re-allocate without another Zoho call. */
  candidates: Allocation[];
  confidence: number;
  source: "already_recorded" | "open_document" | "open_credit" | "learned" | "accepted_rule" | "party_name";
  reason: string;
}

/** Amount tolerance for "equals the balance" when matching a document. */
export const AMOUNT_TOLERANCE = 0.05;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function r2(n: number): number { return Math.round(n * 100) / 100; }
function normalizeNumber(s: string): string { return s.toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function daysBetween(a: string, b: string): number {
  return Math.abs((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86_400_000);
}
function numberInText(line: LineForSuggest, number: string): boolean {
  const n = normalizeNumber(number);
  return n.length >= 4 && normalizeNumber(`${line.description} ${line.reference ?? ""}`).includes(n);
}
function partyNamed(line: LineForSuggest, name: string): boolean {
  const lt = new Set(tokenizeDescription(`${line.description} ${line.reference ?? ""}`));
  const pt = tokenizeDescription(name);
  if (!pt.length || !lt.size) return false;
  const hit = pt.filter((t) => lt.has(t)).length;
  return pt.length === 1 ? hit === 1 && pt[0].length >= 5 : hit >= Math.max(2, Math.ceil(pt.length * 0.6));
}
function toAlloc(d: OpenDoc, applied: number): Allocation {
  return { doc_kind: d.kind, doc_zoho_id: d.zoho_id, doc_number: d.number, amount_applied: r2(applied), balance: d.balance, due_date: d.due_date };
}
function partyInText(line: LineForSuggest, parties: PartyRef[]): { party: PartyRef; score: number } | null {
  const lineTokens = new Set(tokenizeDescription(`${line.description} ${line.reference ?? ""}`));
  if (!lineTokens.size) return null;
  let best: { party: PartyRef; score: number } | null = null;
  for (const p of parties) {
    const pt = tokenizeDescription(p.name);
    if (!pt.length) continue;
    const hit = pt.filter((t) => lineTokens.has(t)).length;
    const ok = pt.length === 1 ? hit === 1 && pt[0].length >= 5 : hit >= Math.max(2, Math.ceil(pt.length * 0.6));
    if (!ok) continue;
    const score = r2(hit / pt.length);
    if (!best || score > best.score || (score === best.score && pt.length > tokenizeDescription(best.party.name).length)) best = { party: p, score };
  }
  return best;
}

/** Exact subset of documents whose balances sum to the amount (n ≤ 14). */
function exactSubset(docs: OpenDoc[], amount: number): OpenDoc[] | null {
  const n = Math.min(docs.length, 14);
  let best: OpenDoc[] | null = null;
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0; const pick: OpenDoc[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { sum += docs[i].balance; pick.push(docs[i]); }
    if (Math.abs(sum - amount) <= AMOUNT_TOLERANCE && (!best || pick.length < best.length)) best = pick;
  }
  return best;
}

function blank(): Pick<Suggestion, "allocations" | "advance_amount" | "bank_charges" | "residual" | "writeoff" | "ref_kind" | "ref_zoho_id" | "ref_number" | "candidates" | "account_id" | "account_name" | "doc_kind" | "doc_zoho_id" | "doc_number" | "doc_balance"> {
  return { allocations: [], advance_amount: 0, bank_charges: 0, residual: 0, writeoff: null, ref_kind: null, ref_zoho_id: null, ref_number: null, candidates: [], account_id: null, account_name: null, doc_kind: null, doc_zoho_id: null, doc_number: null, doc_balance: null };
}
function withFirstDoc(s: Suggestion): Suggestion {
  const a = s.allocations[0];
  if (a) { s.doc_kind = a.doc_kind; s.doc_zoho_id = a.doc_zoho_id; s.doc_number = a.doc_number; s.doc_balance = a.balance; }
  return s;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface SuggestContext {
  patterns: BankPattern[];
  parties: PartyRef[];
  openDocs: OpenDoc[];
  openCredits?: OpenCredit[];
  recorded?: RecordedPost[];
  policies?: Policies;
  /** Statement currency, for the bank-charge tolerance. */
  currency?: string | null;
  /** Today, for the write-off age test (yyyy-mm-dd). */
  today?: string;
}

export function suggestForLines(lines: LineForSuggest[], ctx: SuggestContext): Array<Suggestion | null> {
  const policies = ctx.policies ?? DEFAULT_POLICIES;
  const tolerance = ctx.currency ? (policies.bank_charge_tolerance[ctx.currency.toUpperCase()] ?? 0) : 0;
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const used = new Set<string>(); // a document / credit settles at most one line per statement
  const usedRecorded = new Set<string>();
  const partyById = new Map(ctx.parties.map((p) => [`${p.kind}:${p.zoho_id}`, p]));
  const out: Array<Suggestion | null> = [];

  for (const line of lines) {
    // ---------------------------------------------------- 0. already recorded
    const rec = findRecorded(line, ctx.recorded ?? [], policies.already_recorded_window_days, usedRecorded);
    if (rec) {
      usedRecorded.add(rec.zoho_id);
      out.push({
        ...blank(), txn_kind: "already_recorded",
        party_kind: rec.party_kind, party_zoho_id: rec.party_zoho_id, party_name: rec.party_name,
        ref_kind: rec.ref_kind, ref_zoho_id: rec.zoho_id, ref_number: null,
        confidence: 0.95, source: "already_recorded",
        reason: `${fmt(line.amount)} ${line.side === "credit" ? "in" : "out"}${rec.party_name ? ` for ${rec.party_name}` : ""} was already posted through this app on ${rec.date} (${rec.source}) — link it, don't create it`,
      });
      continue;
    }

    // ---------------------------------------------------------- 1. refunds
    const refund = findRefund(line, ctx.openCredits ?? [], used);
    if (refund) {
      used.add(refund.credit.zoho_id);
      out.push(refund.suggestion);
      continue;
    }

    // ---------------------------------------------------------- 2. retainer
    if (line.side === "credit") {
      const ret = ctx.openDocs.filter((d) => d.kind === "retainer" && !used.has(d.zoho_id) && d.balance > 0)
        .map((d) => ({ d, score: numberInText(line, d.number) ? 0.98 : Math.abs(d.balance - line.amount) <= AMOUNT_TOLERANCE ? (partyNamed(line, d.party_name) ? 0.9 : 0.7) : 0 }))
        .filter((x) => x.score >= BANK_SUGGEST_MIN_CONFIDENCE).sort((a, b) => b.score - a.score)[0];
      if (ret) {
        used.add(ret.d.zoho_id);
        out.push(withFirstDoc({
          ...blank(), txn_kind: "retainer_receipt", party_kind: "customer", party_zoho_id: ret.d.party_zoho_id, party_name: ret.d.party_name,
          allocations: [toAlloc(ret.d, Math.min(line.amount, ret.d.balance))], advance_amount: r2(Math.max(0, line.amount - ret.d.balance)),
          ref_kind: "retainerinvoice", ref_zoho_id: ret.d.zoho_id, ref_number: ret.d.number,
          confidence: ret.score, source: "open_document",
          reason: `retainer invoice ${ret.d.number} (${ret.d.party_name}) is open for ${fmt(ret.d.balance)} — record as a retainer receipt`,
        }));
        continue;
      }
    }

    // ---------------------------------------------------- 3. open documents
    const wantKind = line.side === "credit" ? "invoice" : "bill";
    const pk = wantKind === "invoice" ? "customer" : "vendor";
    const pool = ctx.openDocs.filter((d) => d.kind === wantKind && !used.has(d.zoho_id) && d.balance > 0);

    // Identify the party: named documents → their party; else party name in text; else a learned pattern's party.
    const named = pool.filter((d) => numberInText(line, d.number));
    let party: { zoho_id: string; name: string } | null = named[0] ? { zoho_id: named[0].party_zoho_id, name: named[0].party_name } : null;
    let howParty = named[0] ? `${named.map((d) => d.number).join(", ")} named in the line` : "";
    if (!party) {
      const byName = partyInText(line, ctx.parties.filter((p) => p.kind === pk));
      if (byName) { party = { zoho_id: byName.party.zoho_id, name: byName.party.name }; howParty = `${byName.party.name} appears in the line`; }
    }
    // Amount alone can still identify a document when it is unique.
    if (!party) {
      const byAmount = pool.filter((d) => Math.abs(d.balance - line.amount) <= AMOUNT_TOLERANCE);
      if (byAmount.length === 1) { party = { zoho_id: byAmount[0].party_zoho_id, name: byAmount[0].party_name }; howParty = `${fmt(line.amount)} equals the open balance of ${byAmount[0].number}`; }
    }
    // Learned evidence: identifies the party when nothing else did, and
    // strengthens the suggestion when it agrees with a party found by name.
    let learnedParty: BankPattern | null = null;
    {
      const m = matchBankPattern(line.description, line.side, ctx.patterns);
      const paymentKind = wantKind === "invoice" ? "customer_payment" : "vendor_payment";
      if (isBankMatchSuggestible(m) && m.pattern.txn_kind === paymentKind && m.pattern.party_kind === pk && m.pattern.party_zoho_id) {
        if (!party) {
          const p = partyById.get(`${pk}:${m.pattern.party_zoho_id}`);
          party = { zoho_id: m.pattern.party_zoho_id, name: p?.name ?? m.pattern.party_name ?? "" };
          howParty = `lines like this were ${wantKind === "invoice" ? "receipts from" : "payments to"} ${party.name} before`;
          learnedParty = m.pattern;
        } else if (party.zoho_id === m.pattern.party_zoho_id) {
          howParty += ` (and ${m.pattern.sample_size} earlier lines like this were ${wantKind === "invoice" ? "receipts from" : "payments to"} ${party.name})`;
          learnedParty = m.pattern;
        }
      }
    }

    if (party) {
      const theirs = pool.filter((d) => d.party_zoho_id === party!.zoho_id)
        .sort((a, b) => (a.due_date ?? a.date).localeCompare(b.due_date ?? b.date));
      const candidates = theirs.map((d) => toAlloc(d, 0));
      const owed = r2(theirs.reduce((s, d) => s + d.balance, 0));

      if (theirs.length) {
        // Choose the documents: named → exact subset → FIFO.
        let chosen: OpenDoc[]; let how: string;
        if (named.length && named.every((d) => d.party_zoho_id === party!.zoho_id)) { chosen = named; how = "named in the line"; }
        else {
          const sub = exactSubset(theirs, line.amount);
          if (sub) { chosen = sub; how = sub.length === 1 ? "equals its open balance" : `${sub.map((d) => d.number).join(" + ")} add up exactly`; }
          else { chosen = theirs; how = "oldest due first"; }
        }
        // Allocate the line across the chosen documents in order.
        let remaining = line.amount;
        const allocations: Allocation[] = [];
        for (const d of chosen) {
          if (remaining <= 0) break;
          const applied = Math.min(d.balance, remaining);
          allocations.push(toAlloc(d, applied));
          remaining = r2(remaining - applied);
        }
        const target = r2(chosen.reduce((s, d) => s + d.balance, 0));
        const gap = r2(target - line.amount); // >0 short, <0 over
        let bank_charges = 0, advance = 0, residual = 0, writeoff: Suggestion["writeoff"] = null;
        let outcome = "";
        // Bank charges sit on different sides of the gap:
        //   money IN  — the customer paid the full invoice, the bank kept a
        //               little: the line is SHORT by the charge;
        //   money OUT — we paid the bill plus the bank's fee: the line is
        //               OVER by the charge.
        const chargeGap = line.side === "credit" ? gap : -gap;
        if (chargeGap > 0 && chargeGap <= tolerance && tolerance > 0) {
          bank_charges = chargeGap;
          for (const a of allocations) a.amount_applied = a.balance;
          outcome = line.side === "credit"
            ? `short by ${fmt(chargeGap)} — within the ${ctx.currency} ${tolerance} bank-charge tolerance, so ${chosen.map((d) => d.number).join(", ")} settles in full and ${fmt(chargeGap)} is booked as bank charges`
            : `${fmt(chargeGap)} more than the ${fmt(target)} owed — within the ${ctx.currency} ${tolerance} bank-charge tolerance, so ${chosen.map((d) => d.number).join(", ")} settles in full and ${fmt(chargeGap)} is booked as bank charges`;
        } else if (gap > 0) {
          const last = allocations[allocations.length - 1];
          residual = r2((last?.balance ?? 0) - (last?.amount_applied ?? 0));
          const notReached = chosen.slice(allocations.length);
          outcome = `partial — ${fmt(line.amount)} against ${fmt(target)}; ${last?.doc_number} keeps ${fmt(residual)} open` + (notReached.length ? ` and ${notReached.map((d) => d.number).join(", ")} untouched` : "");
          // Write-off under policy: residual small AND the document old enough.
          if (policies.writeoff_after_days != null && policies.writeoff_max_amount != null && last && residual > 0 && residual <= policies.writeoff_max_amount) {
            const doc = chosen.find((d) => d.zoho_id === last.doc_zoho_id)!;
            const age = doc.due_date ? daysBetween(doc.due_date, today) : daysBetween(doc.date, today);
            const overdue = doc.due_date ? doc.due_date < today : true;
            if (overdue && age >= policies.writeoff_after_days) {
              writeoff = { doc_kind: doc.kind as "invoice" | "bill", doc_zoho_id: doc.zoho_id, doc_number: doc.number, amount: residual,
                reason: `${fmt(residual)} residual on ${doc.number}, ${Math.round(age)} days past due — within the write-off policy (≤ ${fmt(policies.writeoff_max_amount)} after ${policies.writeoff_after_days} days)` };
              outcome += `; write-off of the ${fmt(residual)} residual proposed under policy`;
            } else {
              outcome += `; ${fmt(residual)} residual is under the write-off limit but ${doc.number} is not yet ${policies.writeoff_after_days} days past due`;
            }
          }
        } else if (gap < 0) {
          advance = r2(-gap);
          outcome = `${fmt(line.amount)} is more than the ${fmt(target)} owed — ${fmt(advance)} held as an advance on ${party.name}'s account, not forced onto a document`;
        } else {
          outcome = allocations.length > 1 ? `settles ${allocations.map((a) => a.doc_number).join(", ")} exactly` : `settles ${allocations[0].doc_number} exactly`;
        }
        for (const a of allocations) used.add(a.doc_zoho_id);
        const conf = named.length ? 0.98 : how === "equals its open balance" || how.includes("add up") ? (howParty.includes("appears") || howParty.includes("named") ? 0.9 : 0.7) : learnedParty ? Math.min(0.85, learnedParty.confidence) : 0.75;
        // Amount-only single-doc identification with several same-amount candidates is ambiguous.
        if (howParty.startsWith(fmt(line.amount)) && ctx.openDocs.filter((d) => d.kind === wantKind && !used.has(d.zoho_id) && d.zoho_id !== chosen[0].zoho_id && Math.abs(d.balance - line.amount) <= AMOUNT_TOLERANCE).length) {
          for (const a of allocations) used.delete(a.doc_zoho_id);
          out.push(null); continue;
        }
        out.push(withFirstDoc({
          ...blank(), txn_kind: wantKind === "invoice" ? "customer_payment" : "vendor_payment",
          party_kind: pk, party_zoho_id: party.zoho_id, party_name: party.name,
          allocations, advance_amount: advance, bank_charges, residual, writeoff, candidates,
          confidence: conf, source: "open_document",
          reason: `${howParty}; ${how}; ${outcome}` + (owed > target ? ` (${party.name} has ${fmt(owed)} open in total)` : ""),
        }));
        continue;
      }

      // Party known, nothing open → advance / on account.
      out.push({
        ...blank(), txn_kind: wantKind === "invoice" ? "customer_payment" : "vendor_payment",
        party_kind: pk, party_zoho_id: party.zoho_id, party_name: party.name,
        advance_amount: line.amount, candidates,
        confidence: learnedParty ? Math.min(0.85, learnedParty.confidence) : 0.6, source: learnedParty ? "learned" : "party_name",
        reason: `${howParty}; no open ${wantKind} for ${party.name} — hold ${fmt(line.amount)} as an advance on their account (unused credit)`,
      });
      continue;
    }

    // -------------------------------------------------- 4. learned pattern
    const m = matchBankPattern(line.description, line.side, ctx.patterns);
    if (isBankMatchSuggestible(m)) {
      const p = m.pattern as BankPattern & { suggestion_status?: string };
      const known = p.party_kind && p.party_zoho_id ? partyById.get(`${p.party_kind}:${p.party_zoho_id}`) : null;
      out.push({
        ...blank(), txn_kind: p.txn_kind as SuggestKind, party_kind: p.party_kind, party_zoho_id: p.party_zoho_id, party_name: known?.name ?? p.party_name,
        account_id: p.account_id, account_name: p.account_name,
        advance_amount: (p.txn_kind === "customer_payment" || p.txn_kind === "vendor_payment") ? line.amount : 0,
        confidence: m.score, source: p.suggestion_status === "accepted" ? "accepted_rule" : "learned",
        reason: `${p.sample_size} earlier line${p.sample_size === 1 ? "" : "s"} like “${p.examples[0] ?? p.fingerprint}” were ${describe(p)}` + (p.share < 1 ? ` (${Math.round(p.share * 100)}% of the time)` : ""),
      });
      continue;
    }

    // ------------------------------------------------ 5. party name only
    const pn = partyInText(line, ctx.parties);
    if (pn && pn.score >= 0.6) {
      const isCustomer = pn.party.kind === "customer";
      const kind: SuggestKind = line.side === "credit" ? (isCustomer ? "customer_payment" : "deposit") : (isCustomer ? "other" : "vendor_payment");
      out.push({
        ...blank(), txn_kind: kind, party_kind: pn.party.kind, party_zoho_id: pn.party.zoho_id, party_name: pn.party.name,
        advance_amount: kind === "customer_payment" || kind === "vendor_payment" ? line.amount : 0,
        confidence: r2(pn.score * 0.6), source: "party_name",
        reason: `“${pn.party.name}” appears in the line; no open ${line.side === "credit" ? "invoice" : "bill"} matches and nothing learned yet`,
      });
      continue;
    }

    out.push(null);
  }
  return out;
}

// ---------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------

function findRecorded(line: LineForSuggest, recorded: RecordedPost[], windowDays: number, taken: Set<string>): RecordedPost | null {
  let best: RecordedPost | null = null;
  for (const r of recorded) {
    if (taken.has(r.zoho_id) || r.side !== line.side) continue;
    if (Math.abs(r.amount - line.amount) > AMOUNT_TOLERANCE) continue;
    if (daysBetween(r.date, line.txn_date) > windowDays) continue;
    const sameParty = r.party_zoho_id && (partyNamed(line, r.party_name ?? "") || false);
    const sameText = r.description && tokenizeDescription(r.description).join(" ") === tokenizeDescription(line.description).join(" ") && tokenizeDescription(line.description).length > 0;
    if (!sameParty && !sameText) continue;
    if (!best || daysBetween(r.date, line.txn_date) < daysBetween(best.date, line.txn_date)) best = r;
  }
  return best;
}

function findRefund(line: LineForSuggest, credits: OpenCredit[], used: Set<string>): { credit: OpenCredit; suggestion: Suggestion } | null {
  // Money OUT to a customer refunds a credit note / unused payment; money IN from a vendor refunds a vendor credit / unused payment.
  const wantParty = line.side === "debit" ? "customer" : "vendor";
  let best: { credit: OpenCredit; score: number; how: string } | null = null;
  for (const c of credits) {
    if (c.party_kind !== wantParty || used.has(c.zoho_id) || c.balance <= 0) continue;
    const amt = Math.abs(c.balance - line.amount) <= AMOUNT_TOLERANCE;
    const num = numberInText(line, c.number);
    const nm = partyNamed(line, c.party_name);
    let score = 0, how = "";
    if (num && amt) { score = 0.98; how = `${c.number} is named in the line and ${fmt(line.amount)} equals its balance`; }
    else if (num) { score = 0.85; how = `${c.number} is named in the line`; }
    else if (amt && nm) { score = 0.9; how = `${fmt(line.amount)} equals the open balance of ${c.number} and ${c.party_name} appears in the line`; }
    else if (amt) { score = 0.6; how = `${fmt(line.amount)} equals the open balance of ${c.number} (${c.party_name})`; }
    if (score >= BANK_SUGGEST_MIN_CONFIDENCE && (!best || score > best.score)) best = { credit: c, score, how };
  }
  if (!best) return null;
  // amount-only refund matches with several same-amount credits are ambiguous
  if (best.score === 0.6 && credits.filter((c) => c.party_kind === wantParty && !used.has(c.zoho_id) && Math.abs(c.balance - line.amount) <= AMOUNT_TOLERANCE).length > 1) return null;
  const c = best.credit;
  const kind: SuggestKind = c.kind === "creditnote" ? "creditnote_refund" : c.kind === "vendorcredit" ? "vendorcredit_refund" : c.kind === "customerpayment" ? "payment_refund" : "vendorpayment_refund";
  const what = c.kind === "creditnote" ? "credit note" : c.kind === "vendorcredit" ? "vendor credit" : c.kind === "customerpayment" ? "unused customer payment (advance)" : "unused vendor payment (advance)";
  return { credit: c, suggestion: {
    ...blank(), txn_kind: kind, party_kind: c.party_kind, party_zoho_id: c.party_zoho_id, party_name: c.party_name,
    ref_kind: c.kind, ref_zoho_id: c.zoho_id, ref_number: c.number,
    confidence: best.score, source: "open_credit",
    reason: `${line.side === "debit" ? "money out to" : "money in from"} ${c.party_name}: ${best.how} — refund of ${what} ${c.number}`,
  } };
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
// I/O: open documents and credits from Zoho (metered fetch)
// ---------------------------------------------------------------------------

async function pageAll(zohoFetch: typeof fetch, apiBase: string, orgId: string, token: string, path: string, key: string, params: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let page = 1;
  while (page <= 10) {
    const qs = new URLSearchParams({ organization_id: orgId, per_page: "200", page: String(page), ...params });
    const res = await zohoFetch(`${apiBase}/${path}?${qs}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) break;
    out.push(...(((j as Record<string, unknown>)[key] as Array<Record<string, unknown>>) ?? []));
    if (!(j as { page_context?: { has_more_page?: boolean } }).page_context?.has_more_page) break;
    page++;
  }
  return out;
}

export async function fetchOpenDocuments(zohoFetch: typeof fetch, apiBase: string, orgId: string, token: string): Promise<OpenDoc[]> {
  const out = new Map<string, OpenDoc>();
  for (const [path, kind, key, idKey, numKey, partyId, partyName] of [
    ["invoices", "invoice", "invoices", "invoice_id", "invoice_number", "customer_id", "customer_name"],
    ["bills", "bill", "bills", "bill_id", "bill_number", "vendor_id", "vendor_name"],
  ] as const) {
    for (const status of ["unpaid", "partially_paid", "overdue"]) {
      for (const d of await pageAll(zohoFetch, apiBase, orgId, token, path, key, { status })) {
        const id = String(d[idKey] ?? "");
        if (!id || out.has(id)) continue;
        out.set(id, { kind, zoho_id: id, number: String(d[numKey] ?? ""), party_zoho_id: String(d[partyId] ?? ""), party_name: String(d[partyName] ?? ""),
          date: String(d.date ?? "").slice(0, 10), due_date: d.due_date ? String(d.due_date).slice(0, 10) : null,
          total: Number(d.total ?? 0) || 0, balance: Number(d.balance ?? 0) || 0, currency: d.currency_code != null ? String(d.currency_code) : null });
      }
    }
  }
  // Retainer invoices: open ones with a balance still to be received.
  try {
    for (const d of await pageAll(zohoFetch, apiBase, orgId, token, "retainerinvoices", "retainerinvoices", {})) {
      const id = String(d.retainerinvoice_id ?? "");
      const bal = Number(d.balance ?? 0) || 0;
      const status = String(d.status ?? "").toLowerCase();
      if (!id || bal <= 0 || status === "draft" || status === "void") continue;
      out.set(id, { kind: "retainer", zoho_id: id, number: String(d.retainerinvoice_number ?? ""), party_zoho_id: String(d.customer_id ?? ""), party_name: String(d.customer_name ?? ""),
        date: String(d.date ?? "").slice(0, 10), due_date: null, total: Number(d.total ?? 0) || 0, balance: bal, currency: d.currency_code != null ? String(d.currency_code) : null });
    }
  } catch { /* edition without retainers */ }
  return [...out.values()].filter((d) => d.balance > 0);
}

/** Open credit notes, vendor credits, and payments with an unused amount. */
export async function fetchOpenCredits(zohoFetch: typeof fetch, apiBase: string, orgId: string, token: string): Promise<OpenCredit[]> {
  const out: OpenCredit[] = [];
  for (const d of await pageAll(zohoFetch, apiBase, orgId, token, "creditnotes", "creditnotes", { status: "open" })) {
    const bal = Number(d.balance ?? 0) || 0;
    if (bal > 0) out.push({ kind: "creditnote", zoho_id: String(d.creditnote_id), number: String(d.creditnote_number ?? ""), party_kind: "customer", party_zoho_id: String(d.customer_id ?? ""), party_name: String(d.customer_name ?? ""), date: String(d.date ?? "").slice(0, 10), balance: bal });
  }
  // Zoho lists vendor credits under "vendor_credits" (underscore), unlike creditnotes.
  for (const d of await pageAll(zohoFetch, apiBase, orgId, token, "vendorcredits", "vendor_credits", { status: "open" })) {
    const bal = Number(d.balance ?? 0) || 0;
    if (bal > 0) out.push({ kind: "vendorcredit", zoho_id: String(d.vendor_credit_id), number: String(d.vendor_credit_number ?? ""), party_kind: "vendor", party_zoho_id: String(d.vendor_id ?? ""), party_name: String(d.vendor_name ?? ""), date: String(d.date ?? "").slice(0, 10), balance: bal });
  }
  for (const d of await pageAll(zohoFetch, apiBase, orgId, token, "customerpayments", "customerpayments", {})) {
    const bal = Number(d.unused_amount ?? 0) || 0;
    if (bal > 0) out.push({ kind: "customerpayment", zoho_id: String(d.payment_id), number: String(d.payment_number ?? d.reference_number ?? d.payment_id), party_kind: "customer", party_zoho_id: String(d.customer_id ?? ""), party_name: String(d.customer_name ?? ""), date: String(d.date ?? "").slice(0, 10), balance: bal });
  }
  for (const d of await pageAll(zohoFetch, apiBase, orgId, token, "vendorpayments", "vendorpayments", {})) {
    const bal = Number(d.balance ?? 0) || 0; // vendor payments expose the unapplied part as balance
    if (bal > 0) out.push({ kind: "vendorpayment", zoho_id: String(d.payment_id), number: String(d.payment_number ?? d.reference_number ?? d.payment_id), party_kind: "vendor", party_zoho_id: String(d.vendor_id ?? ""), party_name: String(d.vendor_name ?? ""), date: String(d.date ?? "").slice(0, 10), balance: bal });
  }
  return out;
}
