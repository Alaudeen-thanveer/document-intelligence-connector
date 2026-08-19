/**
 * Month-end nudges. Pure — no I/O.
 *
 * Nudges are things a human should look at before closing a period.
 * Nothing here posts, creates, or changes anything — it only lists.
 */

export interface RecurringJournalDef {
  recurring_journal_id: string;
  recurrence_name: string;
  /** e.g. "months", "weeks", "years" */
  recurrence_frequency: string;
  repeat_every: number;
  start_date: string; // yyyy-mm-dd ("" when only the list view is available)
  end_date: string | null;
  status: string; // active / stopped / expired
  total: number | null;
  /** Zoho's own schedule, from the list view — preferred when present. */
  next_journal_date?: string | null;
  last_journal_date?: string | null;
}

export interface PostedJournal {
  journal_id: string;
  journal_date: string;
  reference_number: string | null;
  notes: string | null;
  total: number | null;
}

export interface EnabledExpectedMissing {
  party_zoho_id: string;
  party_name: string;
  /** From the enabled check's params. */
  next_expected: string | null;
  day_min: number | null;
  day_max: number | null;
}

export interface SeenBill {
  vendor_zoho_id: string | null;
  vendor_name: string | null;
  invoice_date: string | null;
}

export type NudgeKind =
  | "recurring_journal_due"
  | "recurring_journal_posted"
  | "expected_bill_missing"
  | "expected_bill_arrived"
  | "later_than_usual"
  | "bank_reconciliation"
  | "fa_depreciation"
  | "suspense_balance";

export interface Nudge {
  kind: NudgeKind;
  severity: "info" | "attention";
  title: string;
  detail: string;
  /** Stable key so the UI can dedupe / mark handled. */
  key: string;
  ref: Record<string, unknown>;
}

function monthKey(d: string): string {
  return d.slice(0, 7);
}

/** Whether a recurring definition falls due within the given month. */
export function recurringDueInMonth(
  def: RecurringJournalDef,
  month: string, // yyyy-mm
): boolean {
  if (def.status && def.status !== "active") return false;
  // Prefer Zoho's own schedule when the list view provides it: due in the
  // month if the next run falls in it, or the last run already did.
  if (def.next_journal_date || def.last_journal_date) {
    const next = (def.next_journal_date ?? "").slice(0, 7);
    const last = (def.last_journal_date ?? "").slice(0, 7);
    if (next === month || last === month) return true;
    // Next run is in a later month and last was earlier: not this month.
    if (next && next > month) return false;
    // Fall through to arithmetic only when neither date settles it.
  }
  if (!def.start_date) return false;
  const start = def.start_date.slice(0, 7);
  if (start > month) return false;
  if (def.end_date && def.end_date.slice(0, 7) < month) return false;
  const [sy, sm] = start.split("-").map(Number);
  const [y, m] = month.split("-").map(Number);
  const monthsApart = (y - sy) * 12 + (m - sm);
  const every = Math.max(1, def.repeat_every || 1);
  if (def.recurrence_frequency === "months") return monthsApart % every === 0;
  if (def.recurrence_frequency === "years") return monthsApart % (12 * every) === 0;
  // weeks / days recur within every month
  return true;
}

/**
 * Recurring-journal nudges for a period. A definition is "posted" if a
 * journal in the same month references it by name/notes; else it is due.
 */
export function recurringJournalNudges(
  defs: RecurringJournalDef[],
  posted: PostedJournal[],
  month: string,
): Nudge[] {
  const out: Nudge[] = [];
  const postedThisMonth = posted.filter((p) => monthKey(p.journal_date) === month);
  for (const def of defs) {
    if (!recurringDueInMonth(def, month)) continue;
    const name = def.recurrence_name.trim().toLowerCase();
    const hit = postedThisMonth.find((p) =>
      (p.notes ?? "").toLowerCase().includes(name) ||
      (p.reference_number ?? "").toLowerCase().includes(name)
    ) ?? (
      (def.last_journal_date ?? "").slice(0, 7) === month
        ? {
          journal_id: "(per Zoho schedule)",
          journal_date: def.last_journal_date!,
          reference_number: null,
          notes: null,
          total: def.total,
        }
        : undefined
    );
    if (hit) {
      out.push({
        kind: "recurring_journal_posted",
        severity: "info",
        title: `${def.recurrence_name} — posted`,
        detail: `Journal ${hit.journal_id} on ${hit.journal_date}${hit.total != null ? ` for ${hit.total}` : ""}.`,
        key: `rj:${def.recurring_journal_id}:${month}`,
        ref: { recurring_journal_id: def.recurring_journal_id, journal_id: hit.journal_id },
      });
    } else {
      out.push({
        kind: "recurring_journal_due",
        severity: "attention",
        title: `${def.recurrence_name} — not yet posted for ${month}`,
        detail:
          `Recurs every ${def.repeat_every} ${def.recurrence_frequency}` +
          `${def.total != null ? `, usually ${def.total}` : ""}. Check Zoho Books → Journals before closing.`,
        key: `rj:${def.recurring_journal_id}:${month}`,
        ref: { recurring_journal_id: def.recurring_journal_id },
      });
    }
  }
  return out;
}

/**
 * Expected-but-missing bill nudges. Only for vendors whose
 * expected_missing check a human ENABLED. A vendor is "arrived" when any
 * bill from them carries a date in the period.
 */
export function expectedBillNudges(
  enabled: EnabledExpectedMissing[],
  seen: SeenBill[],
  month: string,
  today: string, // yyyy-mm-dd
): Nudge[] {
  const out: Nudge[] = [];
  const todayDay = Number(today.slice(8, 10));
  const isCurrentMonth = monthKey(today) === month;
  for (const e of enabled) {
    const arrived = seen.some((b) =>
      b.invoice_date && monthKey(b.invoice_date) === month &&
      (b.vendor_zoho_id === e.party_zoho_id ||
        (b.vendor_name ?? "").trim().toLowerCase() === e.party_name.trim().toLowerCase())
    );
    if (arrived) {
      out.push({
        kind: "expected_bill_arrived",
        severity: "info",
        title: `${e.party_name} — arrived`,
        detail: `Bill for ${month} is in.`,
        key: `eb:${e.party_zoho_id}:${month}`,
        ref: { party_zoho_id: e.party_zoho_id },
      });
      continue;
    }
    // Still within the vendor's usual window this month → not yet a nudge.
    if (isCurrentMonth && e.day_max != null && todayDay <= e.day_max) continue;
    out.push({
      kind: "expected_bill_missing",
      severity: "attention",
      title: `${e.party_name} — expected, not arrived`,
      detail:
        `Usually bills between day ${e.day_min ?? "?"} and ${e.day_max ?? "?"} each month; ` +
        `nothing for ${month} yet. Chase the vendor or check the mailbox.`,
      key: `eb:${e.party_zoho_id}:${month}`,
      ref: { party_zoho_id: e.party_zoho_id, next_expected: e.next_expected },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layer 5: ENABLED undeclared recurring journals — due vs posted, matched by
// account fingerprint (not by name, since manual journals rarely carry one).
// ---------------------------------------------------------------------------
export interface EnabledJournalPattern {
  fingerprint: string;
  label: string;
  cadence: string;
  amount_median: number | null;
  expected_day_min: number | null;
  expected_day_max: number | null;
}

export interface PostedJournalWithFingerprint extends PostedJournal {
  fingerprint: string;
}

export function journalPatternNudges(
  enabled: EnabledJournalPattern[],
  posted: PostedJournalWithFingerprint[],
  month: string,
): Nudge[] {
  const out: Nudge[] = [];
  const thisMonth = posted.filter((p) => monthKey(p.journal_date) === month);
  for (const e of enabled) {
    const hit = thisMonth.find((p) => p.fingerprint === e.fingerprint);
    if (hit) {
      out.push({
        kind: "recurring_journal_posted",
        severity: "info",
        title: `${e.label} — posted`,
        detail: `Journal ${hit.journal_id} on ${hit.journal_date}${hit.total != null ? ` for ${hit.total}` : ""} (learned pattern).`,
        key: `jp:${e.fingerprint}:${month}`,
        ref: { fingerprint: e.fingerprint, journal_id: hit.journal_id },
      });
    } else {
      out.push({
        kind: "recurring_journal_due",
        severity: "attention",
        title: `${e.label} — not yet posted for ${month}`,
        detail:
          `Posted by hand every month${e.amount_median != null ? `, usually ~${e.amount_median}` : ""}` +
          `${e.expected_day_min != null ? ` around day ${e.expected_day_min}–${e.expected_day_max}` : ""}` +
          ` (learned pattern, enabled by reviewer). Not set up as a Zoho recurring journal.`,
        key: `jp:${e.fingerprint}:${month}`,
        ref: { fingerprint: e.fingerprint },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layer 6: ENABLED "later than usual" — open documents older than the party's
// usual settlement (p90 payment lag).
// ---------------------------------------------------------------------------
export interface EnabledLaterThanUsual {
  party_kind: "vendor" | "customer";
  party_zoho_id: string;
  party_name: string;
  pay_lag_p90: number;
  pay_lag_median: number | null;
}

export interface OpenDoc {
  doc_kind: "bill" | "invoice";
  zoho_id: string;
  number: string | null;
  party_zoho_id: string;
  date: string; // yyyy-mm-dd
  balance: number;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

export function laterThanUsualNudges(
  enabled: EnabledLaterThanUsual[],
  open: OpenDoc[],
  today: string,
): Nudge[] {
  const out: Nudge[] = [];
  for (const e of enabled) {
    const wantKind = e.party_kind === "vendor" ? "bill" : "invoice";
    for (const d of open) {
      if (d.doc_kind !== wantKind || d.party_zoho_id !== e.party_zoho_id) continue;
      if (!(d.balance > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
      const age = daysBetween(d.date, today);
      if (age <= e.pay_lag_p90) continue;
      const label = wantKind === "bill" ? "Bill" : "Invoice";
      out.push({
        kind: "later_than_usual",
        severity: "attention",
        title: `${e.party_name} — ${label.toLowerCase()} ${d.number ?? d.zoho_id} open ${age} days`,
        detail:
          `${label} dated ${d.date}, balance ${d.balance}. This party is usually settled within ` +
          `${e.pay_lag_p90} days${e.pay_lag_median != null ? ` (typically ~${e.pay_lag_median})` : ""}. ` +
          (wantKind === "bill" ? "Check whether payment is overdue." : "Consider chasing the customer."),
        key: `ltu:${d.doc_kind}:${d.zoho_id}`,
        ref: { party_zoho_id: e.party_zoho_id, doc_zoho_id: d.zoho_id, days_open: age },
      });
    }
  }
  return out;
}
