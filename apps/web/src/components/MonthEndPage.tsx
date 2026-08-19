import { useCallback, useEffect, useState } from "react";
import { callEdgeFunction } from "../lib/functions";
import { supabase } from "../lib/supabase";

/**
 * Month-end — what to look at before closing a period, and the two things
 * it can now DO on a click (each recomputed server-side, each confirmed
 * by a human first):
 *   • reconcile a bank account in Zoho when statement = books and nothing
 *     is pending;
 *   • post a proposed journal (from an enabled learned pattern) after the
 *     reviewer has checked — and may have edited — the lines.
 * Everything else still only lists.
 */

interface Nudge {
  kind:
    | "recurring_journal_due"
    | "recurring_journal_posted"
    | "expected_bill_missing"
    | "expected_bill_arrived"
    | "later_than_usual"
    | "bank_reconciliation";
  severity: "info" | "attention";
  title: string;
  detail: string;
  key: string;
  ref?: Record<string, unknown>;
}

interface ReconItem { label: string; amount: number; count: number; detail: string }
interface Reconciliation {
  account: { zoho_id: string; name: string; currency: string | null };
  period_end: string;
  statement_closing: number | null;
  statement_closing_date: string | null;
  book_balance: number | null;
  book_balance_date: string | null;
  difference: number | null;
  items: ReconItem[];
  unexplained: number | null;
  unposted_lines: number;
  uncategorised_in_zoho: number;
  status: "no_statement" | "no_book" | "pending" | "differs" | "balanced";
  can_reconcile: boolean;
  note: string;
}

interface ProposalLine { account_id: string; account_name: string | null; side: "D" | "C"; amount: number; description: string }
interface JournalProposal {
  id: string;
  pattern_id: string;
  period: string;
  journal_date: string;
  reference_number: string | null;
  notes: string | null;
  lines: ProposalLine[];
  total: number;
  status: "proposed" | "posted" | "dismissed";
  zoho_journal_id: string | null;
}

interface LockInfo { locked_until: string | null; already_locked: boolean; ready: boolean; blockers: string[] }
interface CtInfo { applicable: boolean; reason: string; net_profit_ytd?: number; provision_to_date?: number; already_provided?: number; top_up?: number; fy_start?: string }
interface EmirateBox { amount: number; vat: number; count: number }
interface VatForm {
  period: { start: string; end: string };
  boxes: { standard_by_emirate: Record<string, EmirateBox>; standard_total: EmirateBox; reverse_charge_supplies: EmirateBox; zero_rated: EmirateBox; exempt: EmirateBox; outputs_total: EmirateBox; inputs_standard: EmirateBox; inputs_reverse_charge: EmirateBox; inputs_total: EmirateBox; net_vat: number };
  checks: Array<{ name: string; passed: boolean; note: string; docs: string[] }>;
  due_date: string; days_left: number; ready: boolean;
}
interface FxAccount { account_id: string; account_name: string; gl_balance?: number | null; fcy_balance?: number | null; adjusted_balance?: number | null; gain_or_loss?: number | null }

interface MonthEndResult {
  ok: boolean;
  month: string;
  today: string;
  summary: {
    recurring_journal_definitions: number;
    journals_posted_this_month: number;
    expected_bill_checks_enabled: number;
    journal_patterns_enabled?: number;
    later_than_usual_enabled?: number;
    needs_attention: number;
  };
  nudges: Nudge[];
  journal_proposals?: JournalProposal[];
  reconciliations?: Reconciliation[];
  lock?: LockInfo;
  ct?: CtInfo | null;
  warnings?: string[];
  error?: string;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
const money = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function MonthEndPage() {
  const [month, setMonth] = useState(currentMonth());
  const [result, setResult] = useState<MonthEndResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Reviewer edits to proposals, by proposal id.
  const [edits, setEdits] = useState<Record<string, { journal_date: string; lines: ProposalLine[] }>>({});
  // VAT review (Form 201) — runs on demand; it reads many documents from Zoho.
  const [vat, setVat] = useState<{ label: string; form: VatForm } | null>(null);
  const [vatBusy, setVatBusy] = useState(false);
  // FX revaluation.
  const [currencies, setCurrencies] = useState<Array<{ zoho_id: string; name: string }>>([]);
  const [fxCurrency, setFxCurrency] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [fxExposure, setFxExposure] = useState<{ accounts: FxAccount[]; currency_code: string; date: string; rate: number } | null>(null);
  const [forceLock, setForceLock] = useState(false);

  useEffect(() => {
    void supabase.from("zoho_entities").select("zoho_id, name").eq("kind", "currency").neq("name", "AED").then(({ data }) => setCurrencies((data ?? []) as Array<{ zoho_id: string; name: string }>));
  }, []);

  async function runVatReview() {
    setVatBusy(true); setMessage(null);
    const res = await callEdgeFunction("vat-review", {});
    const body = res.body as { ok?: boolean; error?: string; period_label?: string; form?: VatForm };
    if (body.ok && body.form) setVat({ label: body.period_label ?? "", form: body.form });
    else setMessage(`Not reviewed: ${body.error ?? res.status}`);
    setVatBusy(false);
  }
  async function lockPeriod() {
    setBusy("lock"); setMessage(null);
    const res = await callEdgeFunction("month-end", { month, action: "lock_period", ...(forceLock ? { force: true } : {}) });
    const body = res.body as { ok?: boolean; error?: string; locked_until?: string; blockers?: string[] };
    setMessage(body.ok ? `Locked through ${body.locked_until}. Nothing can post into the period from this app.` : `Not locked: ${body.error ?? res.status}${body.blockers?.length ? " — " + body.blockers.join("; ") : ""}`);
    setBusy(null); setForceLock(false);
    await load(month);
  }
  async function unlockPeriod() {
    setBusy("lock"); setMessage(null);
    const res = await callEdgeFunction("month-end", { month, action: "unlock_period" });
    const body = res.body as { ok?: boolean; error?: string };
    setMessage(body.ok ? "Unlocked (audited)." : `Not unlocked: ${body.error ?? res.status}`);
    setBusy(null);
    await load(month);
  }
  async function checkFx() {
    if (!fxCurrency || !fxRate) return;
    setBusy("fx"); setMessage(null); setFxExposure(null);
    const res = await callEdgeFunction("month-end", { month, action: "fx_exposure", currency_id: fxCurrency, exchange_rate: fxRate });
    const body = res.body as { ok?: boolean; error?: string; exposure?: { accounts: FxAccount[]; currency_code: string }; adjustment_date?: string; exchange_rate?: number };
    if (body.ok && body.exposure) setFxExposure({ accounts: body.exposure.accounts, currency_code: body.exposure.currency_code, date: body.adjustment_date ?? "", rate: body.exchange_rate ?? Number(fxRate) });
    else setMessage(`Exposure not read: ${body.error ?? res.status}`);
    setBusy(null);
  }
  async function postFx() {
    setBusy("fx"); setMessage(null);
    const res = await callEdgeFunction("month-end", { month, action: "post_bca", currency_id: fxCurrency, exchange_rate: fxRate });
    const body = res.body as { ok?: boolean; error?: string };
    setMessage(body.ok ? "Revaluation posted in Zoho Books (base currency adjustment)." : `Not posted: ${body.error ?? res.status}`);
    setBusy(null); setFxExposure(null);
    await load(month);
  }

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    const res = await callEdgeFunction("month-end", { month: m });
    if (!res.ok || (res.body as { ok?: boolean }).ok === false) {
      setError(
        String(
          (res.body as { error?: string }).error ??
            `Month-end check failed (${res.status}) — is functions serve running?`,
        ),
      );
      setResult(null);
    } else {
      setResult(res.body as unknown as MonthEndResult);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(month);
  }, [month, load]);

  const attention = result?.nudges.filter((n) => n.severity === "attention" && n.kind !== "bank_reconciliation") ?? [];
  const info = result?.nudges.filter((n) => n.severity === "info" && n.kind !== "bank_reconciliation") ?? [];
  const recons = result?.reconciliations ?? [];
  const proposals = result?.journal_proposals ?? [];

  async function reconcile(accountId: string) {
    setBusy(`recon:${accountId}`);
    setMessage(null);
    const res = await callEdgeFunction("month-end", { month, action: "reconcile", bank_account_zoho_id: accountId });
    const body = res.body as { ok?: boolean; error?: string };
    setMessage(body.ok ? "Reconciled in Zoho Books." : `Not reconciled: ${body.error ?? res.status}`);
    setBusy(null);
    await load(month);
  }

  async function decideJournal(p: JournalProposal, action: "post_journal" | "dismiss_journal") {
    setBusy(`jnl:${p.id}`);
    setMessage(null);
    const e = edits[p.id];
    const res = await callEdgeFunction("month-end", {
      month, action, proposal_id: p.id,
      ...(e ? { journal_date: e.journal_date, lines: e.lines } : {}),
    });
    const body = res.body as { ok?: boolean; error?: string; zoho_journal_id?: string | null };
    setMessage(body.ok ? (action === "post_journal" ? `Journal posted to Zoho${body.zoho_journal_id ? ` (${body.zoho_journal_id})` : ""}.` : "Proposal dismissed.") : `Not done: ${body.error ?? res.status}`);
    setBusy(null);
    await load(month);
  }

  function editLine(p: JournalProposal, idx: number, amount: number) {
    const cur = edits[p.id] ?? { journal_date: p.journal_date, lines: p.lines.map((l) => ({ ...l })) };
    const lines = cur.lines.map((l, i) => (i === idx ? { ...l, amount } : l));
    setEdits({ ...edits, [p.id]: { ...cur, lines } });
  }
  function editDate(p: JournalProposal, date: string) {
    const cur = edits[p.id] ?? { journal_date: p.journal_date, lines: p.lines.map((l) => ({ ...l })) };
    setEdits({ ...edits, [p.id]: { ...cur, journal_date: date } });
  }

  return (
    <main className="connections-layout">
      <div className="pane-heading">
        <h2>Month-end</h2>
        <div className="month-nav">
          <button type="button" className="btn ghost btn-small" onClick={() => setMonth(shiftMonth(month, -1))}>
            ‹
          </button>
          <strong>{monthLabel(month)}</strong>
          <button
            type="button"
            className="btn ghost btn-small"
            disabled={month >= currentMonth()}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
          <button type="button" className="btn ghost btn-small" disabled={loading} onClick={() => void load(month)}>
            {loading ? "Checking…" : "Refresh"}
          </button>
        </div>
      </div>
      <p className="muted connections-intro">
        Things to look at before closing the period. Two of them can be done from here —
        reconciling a bank account and posting a proposed journal — and each one waits for
        your click. Everything else only tells you what is due, done, or missing.
      </p>

      {error && <p className="error-text">{error}</p>}
      {message && <p className="muted" style={{ color: message.startsWith("Not") ? "var(--warn)" : "var(--ok, inherit)" }}>{message}</p>}
      {result?.warnings?.map((w) => (
        <p key={w} className="muted" style={{ color: "var(--warn)" }}>
          {w}
        </p>
      ))}

      {result && (
        <div className="conn-kind-grid">
          <div className="conn-kind-tile" style={{ cursor: "default" }}>
            <span className="conn-kind-count" style={{ color: result.summary.needs_attention ? "var(--warn)" : undefined }}>
              {result.summary.needs_attention}
            </span>
            <span className="conn-kind-label">Need attention</span>
          </div>
          <div className="conn-kind-tile" style={{ cursor: "default" }}>
            <span className="conn-kind-count">{recons.filter((r) => r.status === "balanced").length}/{recons.length}</span>
            <span className="conn-kind-label">Bank accounts ready to reconcile</span>
          </div>
          <div className="conn-kind-tile" style={{ cursor: "default" }}>
            <span className="conn-kind-count">{proposals.filter((p) => p.status === "proposed").length}</span>
            <span className="conn-kind-label">Journals proposed, awaiting you</span>
          </div>
          <div className="conn-kind-tile" style={{ cursor: "default" }}>
            <span className="conn-kind-count">{result.summary.journals_posted_this_month}</span>
            <span className="conn-kind-label">Journals posted this month</span>
          </div>
        </div>
      )}

      {result && (
        <section className="panel connection-card">
          <h3>Bank reconciliation</h3>
          {recons.length === 0 ? (
            <p className="muted">No bank account has statement lines here or transactions in Zoho yet.</p>
          ) : (
            <ul className="conn-entity-list">
              {recons.map((r) => (
                <li key={r.account.zoho_id} style={{ alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <strong>{r.account.name}</strong>
                    <div className="muted" style={{ marginTop: 4 }}>
                      Statement {money(r.statement_closing)}{r.statement_closing_date ? ` (${r.statement_closing_date})` : ""} · Books {money(r.book_balance)}{r.book_balance_date ? ` (${r.book_balance_date})` : ""}
                      {r.difference != null && <> · Difference <strong style={{ color: Math.abs(r.difference) > 0.005 ? "var(--warn)" : undefined }}>{money(r.difference)}</strong></>}
                    </div>
                    <div className="muted" style={{ marginTop: 4 }}>{r.note}</div>
                    {r.items.length > 0 && (
                      <table className="data-table" style={{ marginTop: 8, width: "auto" }}>
                        <tbody>
                          {r.items.map((it) => (
                            <tr key={it.label}>
                              <td>{it.label}{it.count ? ` (${it.count})` : ""}</td>
                              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(it.amount)}</td>
                              <td className="muted">{it.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                    <span className={`status-pill ${r.status === "balanced" ? "status-synced" : r.status === "no_book" ? "status-pending" : "status-needs_review"}`}>
                      {r.status === "balanced" ? "balanced" : r.status === "pending" ? "pending" : r.status === "differs" ? "differs" : r.status === "no_statement" ? "no statement" : "nothing in Zoho"}
                    </span>
                    {r.can_reconcile && (
                      <button type="button" className="btn btn-small" disabled={busy != null} onClick={() => void reconcile(r.account.zoho_id)}>
                        {busy === `recon:${r.account.zoho_id}` ? "Reconciling…" : "Reconcile in Zoho"}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {result && (
        <section className="panel connection-card">
          <h3>Period lock</h3>
          {result.lock?.already_locked ? (
            <p className="muted">Locked through <strong>{result.lock.locked_until}</strong> — nothing can post into the period from this app. Unlock (audited) to change history.</p>
          ) : (
            <>
              <p className="muted">
                {result.lock?.ready
                  ? `Everything reconciled and decided for ${monthLabel(month)} — lock it so nothing back-dates into a filed period.`
                  : `Not ready to lock:`}
              </p>
              {!result.lock?.ready && (
                <ul className="conn-entity-list">{(result.lock?.blockers ?? []).map((b) => <li key={b}><div className="muted">{b}</div></li>)}</ul>
              )}
              {result.lock?.locked_until && <p className="muted">Currently locked through {result.lock.locked_until}.</p>}
            </>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
            {!result.lock?.already_locked && (
              <button type="button" className="btn btn-small" disabled={busy != null || (!result.lock?.ready && !forceLock)} onClick={() => void lockPeriod()}>
                {busy === "lock" ? "Working…" : `Lock through ${result.month}-…`}
              </button>
            )}
            {!result.lock?.ready && !result.lock?.already_locked && (
              <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={forceLock} onChange={(e) => setForceLock(e.target.checked)} /> lock anyway (audited with the open items)
              </label>
            )}
            {result.lock?.locked_until && (
              <button type="button" className="btn ghost btn-small" disabled={busy != null} onClick={() => void unlockPeriod()}>Unlock</button>
            )}
          </div>
        </section>
      )}

      {result && (
        <section className="panel connection-card">
          <h3>VAT return (Form 201) — pre-filing review</h3>
          <p className="muted">
            Recomputes the period's boxes from the documents in Zoho Books and lists what to look at
            before filing in the FTA portal. This reviews — filing stays in the portal.
          </p>
          <button type="button" className="btn btn-small" disabled={vatBusy} onClick={() => void runVatReview()}>
            {vatBusy ? "Reading the period's documents…" : vat ? "Re-run review" : "Run VAT review"}
          </button>
          {vat && (
            <div style={{ marginTop: 10 }}>
              <p><strong>{vat.label}</strong> · due <strong>{vat.form.due_date}</strong> ({vat.form.days_left >= 0 ? `${vat.form.days_left} days left` : `${-vat.form.days_left} days OVERDUE`}) · {vat.form.ready ? <span className="status-pill status-synced">checks pass</span> : <span className="status-pill status-needs_review">needs attention</span>}</p>
              <table className="data-table" style={{ marginTop: 8 }}>
                <tbody>
                  {Object.entries(vat.form.boxes.standard_by_emirate).map(([em, b]) => (
                    <tr key={em}><td>Standard-rated supplies — {em}</td><td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(b.amount)}</td><td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(b.vat)}</td></tr>
                  ))}
                  <tr><td>Zero-rated supplies</td><td style={{ textAlign: "right" }}>{money(vat.form.boxes.zero_rated.amount)}</td><td style={{ textAlign: "right" }}>—</td></tr>
                  <tr><td>Exempt supplies</td><td style={{ textAlign: "right" }}>{money(vat.form.boxes.exempt.amount)}</td><td style={{ textAlign: "right" }}>—</td></tr>
                  <tr><td>Reverse-charge supplies (imports)</td><td style={{ textAlign: "right" }}>{money(vat.form.boxes.reverse_charge_supplies.amount)}</td><td style={{ textAlign: "right" }}>{money(vat.form.boxes.reverse_charge_supplies.vat)}</td></tr>
                  <tr><td>Standard-rated expenses (recoverable)</td><td style={{ textAlign: "right" }}>{money(vat.form.boxes.inputs_standard.amount)}</td><td style={{ textAlign: "right" }}>{money(vat.form.boxes.inputs_standard.vat)}</td></tr>
                  <tr><td><strong>Net VAT {vat.form.boxes.net_vat >= 0 ? "payable" : "recoverable"}</strong></td><td></td><td style={{ textAlign: "right" }}><strong>{money(Math.abs(vat.form.boxes.net_vat))}</strong></td></tr>
                </tbody>
              </table>
              <ul className="conn-entity-list" style={{ marginTop: 8 }}>
                {vat.form.checks.map((c) => (
                  <li key={c.name}>
                    <div>
                      <strong>{c.passed ? "✓" : "✗"} {c.name.replace(/_/g, " ")}</strong>
                      <div className="muted">{c.note}{c.docs.length > 0 && c.docs.length <= 5 ? ` — ${c.docs.join("; ")}` : ""}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {result && (
        <section className="panel connection-card">
          <h3>Currency revaluation</h3>
          <p className="muted">
            Foreign-currency balances at the period-end rate. Zoho computes and posts the gain or loss
            (base currency adjustment); the rate is yours — enter your period-end closing rate.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select value={fxCurrency} onChange={(e) => { setFxCurrency(e.target.value); setFxExposure(null); }}>
              <option value="">Currency…</option>
              {currencies.map((c) => <option key={c.zoho_id} value={c.zoho_id}>{c.name}</option>)}
            </select>
            <input type="number" step="0.0001" min="0" placeholder="Rate (AED per 1 unit)" style={{ width: 170 }} value={fxRate} onChange={(e) => { setFxRate(e.target.value); setFxExposure(null); }} />
            <button type="button" className="btn btn-small" disabled={busy != null || !fxCurrency || !fxRate} onClick={() => void checkFx()}>
              {busy === "fx" && !fxExposure ? "Checking…" : "Check exposure"}
            </button>
          </div>
          {fxExposure && (
            <div style={{ marginTop: 10 }}>
              {fxExposure.accounts.length === 0 ? (
                <p className="muted">Zoho reports nothing to revalue for {fxExposure.currency_code} at {fxExposure.rate} on {fxExposure.date}.</p>
              ) : (
                <>
                  <table className="data-table">
                    <thead><tr><th>Account</th><th>FCY balance</th><th>Book (AED)</th><th>At {fxExposure.rate}</th><th>Gain / loss</th></tr></thead>
                    <tbody>
                      {fxExposure.accounts.map((a) => (
                        <tr key={a.account_id}><td>{a.account_name}</td><td style={{ textAlign: "right" }}>{money(a.fcy_balance)}</td><td style={{ textAlign: "right" }}>{money(a.gl_balance)}</td><td style={{ textAlign: "right" }}>{money(a.adjusted_balance)}</td><td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(a.gain_or_loss)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <button type="button" className="btn btn-small" style={{ marginTop: 8 }} disabled={busy != null} onClick={() => void postFx()}>
                    {busy === "fx" ? "Posting…" : "Post the adjustment in Zoho"}
                  </button>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {result && result.ct && (
        <section className="panel connection-card">
          <h3>Corporate tax provision</h3>
          <p className="muted">{result.ct.reason}</p>
          {result.ct.net_profit_ytd != null && (
            <p className="muted">FY-to-date result {money(result.ct.net_profit_ytd)}{result.ct.fy_start ? ` since ${result.ct.fy_start}` : ""} · provision to date {money(result.ct.provision_to_date ?? 0)} · already provided {money(result.ct.already_provided ?? 0)}.
            {(result.ct.top_up ?? 0) > 0 ? " The proposed journal is below under Proposed journals." : ""}</p>
          )}
        </section>
      )}

      {result && proposals.length > 0 && (
        <section className="panel connection-card">
          <h3>Proposed journals</h3>
          <p className="muted">
            From the journal patterns you enabled on the Rules screen and that are not yet in the books
            for {monthLabel(month)}. Check the lines — edit the amounts or the date if needed — then post.
          </p>
          {proposals.map((p) => {
            const e = edits[p.id];
            const lines = e?.lines ?? p.lines;
            const date = e?.journal_date ?? p.journal_date;
            const d = lines.filter((l) => l.side === "D").reduce((s, l) => s + Number(l.amount || 0), 0);
            const c = lines.filter((l) => l.side === "C").reduce((s, l) => s + Number(l.amount || 0), 0);
            const balanced = Math.abs(d - c) <= 0.005 && d > 0;
            const open = p.status === "proposed";
            return (
              <div key={p.id} className="bank-line" style={{ marginTop: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                  <strong>{lines[0]?.description ?? "Journal"}</strong>
                  <span className={`status-pill ${p.status === "posted" ? "status-synced" : p.status === "dismissed" ? "status-pending" : "status-needs_review"}`}>
                    {p.status === "posted" ? `posted${p.zoho_journal_id ? ` · ${p.zoho_journal_id}` : ""}` : p.status}
                  </span>
                </div>
                {p.notes && <div className="muted" style={{ marginTop: 4 }}>{p.notes}</div>}
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
                  <label className="muted">Date <input type="date" value={date} disabled={!open} onChange={(ev) => editDate(p, ev.target.value)} /></label>
                  {p.reference_number && <span className="muted">Ref {p.reference_number}</span>}
                </div>
                <table className="data-table" style={{ marginTop: 8 }}>
                  <thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={`${l.account_id}-${i}`}>
                        <td>{l.account_name ?? l.account_id}</td>
                        <td>{l.side === "D" ? <input type="number" step="0.01" min="0" style={{ width: 120, textAlign: "right" }} value={l.amount} disabled={!open} onChange={(ev) => editLine(p, i, Number(ev.target.value))} /> : ""}</td>
                        <td>{l.side === "C" ? <input type="number" step="0.01" min="0" style={{ width: 120, textAlign: "right" }} value={l.amount} disabled={!open} onChange={(ev) => editLine(p, i, Number(ev.target.value))} /> : ""}</td>
                      </tr>
                    ))}
                    <tr><td className="muted">Total</td><td style={{ fontVariantNumeric: "tabular-nums" }}>{money(d)}</td><td style={{ fontVariantNumeric: "tabular-nums" }}>{money(c)}</td></tr>
                  </tbody>
                </table>
                {open && (
                  <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                    <button type="button" className="btn btn-small" disabled={busy != null || !balanced} onClick={() => void decideJournal(p, "post_journal")}>
                      {busy === `jnl:${p.id}` ? "Posting…" : "Post to Zoho"}
                    </button>
                    <button type="button" className="btn ghost btn-small" disabled={busy != null} onClick={() => void decideJournal(p, "dismiss_journal")}>
                      Not this month
                    </button>
                    {!balanced && <span className="muted">{d === 0 ? "Fill in the amounts first." : "Debits and credits must balance."}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {result && (
        <section className="panel connection-card">
          <h3>Needs attention</h3>
          {attention.length === 0 ? (
            <p className="muted">
              Nothing outstanding for {monthLabel(month)}
              {result.summary.expected_bill_checks_enabled === 0 &&
                result.summary.recurring_journal_definitions === 0 &&
                " — no recurring journals are defined in Zoho and no vendors are watched yet. Enable “Expected but missing” checks on the Rules screen to watch vendors."}
              .
            </p>
          ) : (
            <ul className="conn-entity-list">
              {attention.map((n) => (
                <li key={n.key}>
                  <div>
                    <strong>{n.title}</strong>
                    <div className="muted">{n.detail}</div>
                  </div>
                  <span className="status-pill status-needs_review">
                    {n.kind === "recurring_journal_due"
                      ? "journal due"
                      : n.kind === "later_than_usual"
                        ? "open too long"
                        : "bill missing"}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {info.length > 0 && (
            <>
              <h3 style={{ marginTop: 18 }}>Done this month</h3>
              <ul className="conn-entity-list">
                {info.map((n) => (
                  <li key={n.key}>
                    <div>
                      <strong>{n.title}</strong>
                      <div className="muted">{n.detail}</div>
                    </div>
                    <span className="status-pill status-synced">
                      {n.kind === "recurring_journal_posted" ? "posted" : "arrived"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </main>
  );
}
