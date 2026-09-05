/**
 * Journal proposals — pure.
 *
 * From "this journal is usually posted by hand every month and isn't yet"
 * (the layer-5 nudge) to "here is the entry, confirm it". For an ENABLED
 * learned journal pattern not posted in the period, build the draft:
 *   date   = the usual day of the month (clamped to the period), never
 *            later than the period end;
 *   lines  = the pattern's accounts with their sides, the median amount
 *            spread evenly over the debit side and over the credit side
 *            (one debit / one credit is the common shape — then it is
 *            simply median on each);
 *   notes  = why it is proposed, in plain words.
 * A pattern without a median amount gets a draft with zero amounts the
 * reviewer must fill in (the structure is still known).
 *
 * The human confirms (optionally edits amounts / date); only then is it
 * POSTed to Zoho as /journals. Zoho body (verified live on earlier work):
 * { journal_date, reference_number, notes, line_items:[{account_id, debit_or_credit, amount, description}] }.
 */

export interface PatternForProposal {
  id: string;
  fingerprint: string;
  label: string;
  accounts: Array<{ account_id: string; account_name: string | null; side: "D" | "C" }>;
  amount_median: number | null;
  expected_day_min: number | null;
  expected_day_max: number | null;
  recurring_note?: string | null;
}
export interface ProposalLine { account_id: string; account_name: string | null; side: "D" | "C"; amount: number; description: string }
export interface JournalProposal {
  pattern_id: string;
  period: string; // yyyy-mm
  journal_date: string;
  reference_number: string;
  notes: string;
  lines: ProposalLine[];
  total: number;
  needs_amount: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
/** 6-hex-char tag of a fingerprint (Zoho ids share long prefixes, so a prefix would not distinguish). */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6).toUpperCase();
}

function lastDayOf(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function proposalDate(p: PatternForProposal, period: string, today: string): string {
  const last = lastDayOf(period);
  const usual = p.expected_day_max ?? p.expected_day_min ?? last;
  const day = Math.min(Math.max(1, usual), last);
  const d = `${period}-${String(day).padStart(2, "0")}`;
  // Never date a proposal in the future when the period is the current month.
  return d > today && today.slice(0, 7) === period ? today : d;
}

/** Spread an amount evenly over n lines, cents to the first line. */
export function spread(amount: number, n: number): number[] {
  if (n <= 0) return [];
  const each = Math.floor((amount * 100) / n) / 100;
  const out = Array(n).fill(each);
  out[0] = r2(out[0] + (amount - each * n));
  return out.map(r2);
}

export function buildJournalProposal(p: PatternForProposal, period: string, today: string): JournalProposal | null {
  const debits = p.accounts.filter((a) => a.side === "D");
  const credits = p.accounts.filter((a) => a.side === "C");
  if (!debits.length || !credits.length) return null; // not a postable shape
  const median = p.amount_median != null && p.amount_median > 0 ? r2(p.amount_median) : null;
  const dAmts = spread(median ?? 0, debits.length);
  const cAmts = spread(median ?? 0, credits.length);
  const lines: ProposalLine[] = [
    ...debits.map((a, i) => ({ account_id: a.account_id, account_name: a.account_name, side: "D" as const, amount: dAmts[i], description: p.label })),
    ...credits.map((a, i) => ({ account_id: a.account_id, account_name: a.account_name, side: "C" as const, amount: cAmts[i], description: p.label })),
  ];
  const when = p.expected_day_min != null ? ` around day ${p.expected_day_min}${p.expected_day_max != null && p.expected_day_max !== p.expected_day_min ? `–${p.expected_day_max}` : ""}` : "";
  return {
    pattern_id: p.id,
    period,
    journal_date: proposalDate(p, period, today),
    reference_number: `DIC-JNL-${period}-${shortHash(p.fingerprint)}`,
    notes: `${p.label} — proposed by the connector for ${period}: posted by hand every month${when}${median != null ? `, usually ~${median.toFixed(2)}` : ""}. Not a Zoho recurring journal. Confirmed by a reviewer before posting.`,
    lines,
    total: median ?? 0,
    needs_amount: median == null,
  };
}

/** Validate reviewer edits and build the Zoho body. */
export function journalBody(proposal: { journal_date: string; reference_number: string | null; notes: string | null; lines: ProposalLine[] }, currencyId?: string | null): { ok: true; body: Record<string, unknown>; total: number } | { ok: false; error: string } {
  const d = proposal.lines.filter((l) => l.side === "D").reduce((s, l) => s + Number(l.amount), 0);
  const c = proposal.lines.filter((l) => l.side === "C").reduce((s, l) => s + Number(l.amount), 0);
  if (!proposal.lines.length) return { ok: false, error: "No lines." };
  if (proposal.lines.some((l) => !l.account_id)) return { ok: false, error: "Every line needs an account." };
  if (proposal.lines.some((l) => !(Number(l.amount) > 0))) return { ok: false, error: "Every line needs an amount above zero." };
  if (Math.abs(d - c) > 0.005) return { ok: false, error: `Debits ${d.toFixed(2)} and credits ${c.toFixed(2)} do not balance.` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(proposal.journal_date)) return { ok: false, error: "Journal date must be yyyy-mm-dd." };
  return {
    ok: true,
    total: r2(d),
    body: {
      journal_date: proposal.journal_date,
      ...(proposal.reference_number ? { reference_number: proposal.reference_number } : {}),
      ...(proposal.notes ? { notes: proposal.notes.slice(0, 500) } : {}),
      ...(currencyId ? { currency_id: currencyId } : {}),
      line_items: proposal.lines.map((l) => ({ account_id: l.account_id, debit_or_credit: l.side === "D" ? "debit" : "credit", amount: r2(Number(l.amount)), ...(l.description ? { description: l.description.slice(0, 200) } : {}) })),
    },
  };
}
