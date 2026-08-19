/**
 * Fixed assets + prepayment/accrual schedules — pure.
 *
 * FOLLOW-UPS FROM A BILL. After a bill is approved, its lines are read
 * against the chart of accounts:
 *   • a line coded to a fixed_asset account → propose creating the asset
 *     record in Zoho's Fixed Assets module (a human confirms; nothing is
 *     created on its own);
 *   • a line coded to a current-asset account whose NAME says "prepaid"
 *     → propose a prepayment schedule (N monthly entries moving the cost
 *     from the prepaid account to the expense account).
 * Anything else is nobody's business here.
 *
 * SCHEDULES. A schedule spreads `total` over `months` starting at
 * `start_period`: equal monthly amounts, the rounding tail on the LAST
 * month. Each due month (start … current period, not yet proposed)
 * becomes a journal proposal — Dr the P&L account, Cr the balance-sheet
 * account. The same shape serves both kinds: crediting a prepaid ASSET
 * releases it; crediting an accrued LIABILITY builds it. Posting rides
 * the existing confirm-to-post machinery (validation, period lock, never
 * twice).
 *
 * DEPRECIATION RAN. When the org has active fixed assets, month-end
 * checks a depreciation journal exists in the month; none → attention.
 */

export interface AccountInfo { name: string; account_type: string }
export interface BillLineForFollowup { description: string | null; amount: number; account_id: string | null }
export interface Followups {
  assets: Array<{ description: string; amount: number; account_id: string; account_name: string }>;
  prepayments: Array<{ description: string; amount: number; account_id: string; account_name: string }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function detectFollowups(lines: BillLineForFollowup[], accounts: Map<string, AccountInfo>): Followups {
  const out: Followups = { assets: [], prepayments: [] };
  for (const l of lines) {
    if (!l.account_id || !(l.amount > 0)) continue;
    const acc = accounts.get(l.account_id);
    if (!acc) continue;
    const row = { description: (l.description ?? "").trim() || acc.name, amount: r2(l.amount), account_id: l.account_id, account_name: acc.name };
    if (acc.account_type === "fixed_asset") out.assets.push(row);
    else if (/prepaid/i.test(acc.name) && ["other_current_asset", "other_asset"].includes(acc.account_type)) out.prepayments.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schedule arithmetic
// ---------------------------------------------------------------------------
export interface ScheduleRow {
  id: string;
  kind: "prepayment" | "accrual";
  label: string;
  bs_account_id: string;
  bs_account_name: string | null;
  pl_account_id: string;
  pl_account_name: string | null;
  total: number;
  months: number;
  start_period: string; // yyyy-mm
}

/** Equal monthly amounts; the rounding tail lands on the LAST month. */
export function monthlyAmounts(total: number, months: number): number[] {
  if (months <= 0) return [];
  const each = Math.round((total / months) * 100) / 100;
  const out = Array(months).fill(each);
  out[months - 1] = r2(total - each * (months - 1));
  return out;
}

export function schedulePeriods(startPeriod: string, months: number): string[] {
  const [y, m] = startPeriod.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export function lastDayOf(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, "0")}`;
}

export function validateSchedule(s: { kind: string; label: string; bs_account_id: string; pl_account_id: string; total: number; months: number; start_period: string }): { ok: true } | { ok: false; error: string } {
  if (!["prepayment", "accrual"].includes(s.kind)) return { ok: false, error: "Kind must be prepayment or accrual." };
  if (!s.label.trim()) return { ok: false, error: "Give the schedule a name." };
  if (!s.bs_account_id || !s.pl_account_id) return { ok: false, error: "Pick both accounts — the balance-sheet side and the P&L side." };
  if (s.bs_account_id === s.pl_account_id) return { ok: false, error: "The two accounts must differ." };
  if (!(s.total > 0)) return { ok: false, error: "The total must be above zero." };
  if (!Number.isInteger(s.months) || s.months < 1 || s.months > 60) return { ok: false, error: "Months must be a whole number between 1 and 60." };
  if (!/^\d{4}-\d{2}$/.test(s.start_period)) return { ok: false, error: "Start period must be yyyy-mm." };
  return { ok: true };
}

export interface DueEntry {
  period: string;
  journal_date: string;
  amount: number;
  reference_number: string;
  notes: string;
  lines: Array<{ account_id: string; account_name: string | null; side: "D" | "C"; amount: number; description: string }>;
}

/** The entries due up to (and including) the current period that are not proposed yet. */
export function dueScheduleEntries(s: ScheduleRow, alreadyProposedPeriods: string[], currentPeriod: string, today: string): DueEntry[] {
  const periods = schedulePeriods(s.start_period, s.months);
  const amounts = monthlyAmounts(s.total, s.months);
  const done = new Set(alreadyProposedPeriods);
  const out: DueEntry[] = [];
  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    if (period > currentPeriod || done.has(period)) continue;
    const end = lastDayOf(period);
    const monthNo = i + 1;
    out.push({
      period,
      journal_date: end <= today ? end : today,
      amount: amounts[i],
      reference_number: `DIC-SCH-${period}-${s.id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      notes: `${s.label} — month ${monthNo} of ${s.months} (${s.kind === "prepayment" ? "releasing the prepayment to expense" : "accruing the expense"}): ${amounts[i].toFixed(2)} of ${s.total.toFixed(2)} total. Proposed by the connector; confirmed by a reviewer before posting.`,
      lines: [
        { account_id: s.pl_account_id, account_name: s.pl_account_name, side: "D", amount: amounts[i], description: `${s.label} ${monthNo}/${s.months}` },
        { account_id: s.bs_account_id, account_name: s.bs_account_name, side: "C", amount: amounts[i], description: `${s.label} ${monthNo}/${s.months}` },
      ],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixed assets: "did depreciation run?"
// ---------------------------------------------------------------------------
export function faDepreciationNudge(
  activeAssets: number,
  monthJournals: Array<{ journal_id: string; journal_date: string; reference_number: string | null; notes: string | null }>,
  month: string,
): { kind: string; severity: "info" | "attention"; title: string; detail: string; key: string; ref: Record<string, unknown> } | null {
  if (activeAssets <= 0) return null;
  const hit = monthJournals.find((j) => /depreciation/i.test(`${j.reference_number ?? ""} ${j.notes ?? ""}`));
  if (hit) {
    return { kind: "fa_depreciation", severity: "info", title: "Fixed-asset depreciation — posted", detail: `Journal ${hit.journal_id} on ${hit.journal_date} mentions depreciation; ${activeAssets} active asset(s) in the register.`, key: `fadep:${month}`, ref: { journal_id: hit.journal_id } };
  }
  return { kind: "fa_depreciation", severity: "attention", title: `Fixed-asset depreciation — not yet posted for ${month}`, detail: `${activeAssets} active asset(s) in Zoho's Fixed Assets register but no depreciation journal this month. Run it in Zoho Books (Fixed Assets → Record Depreciation) before closing.`, key: `fadep:${month}`, ref: {} };
}
