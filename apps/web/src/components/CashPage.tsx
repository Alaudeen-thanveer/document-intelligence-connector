import { useCallback, useEffect, useState } from "react";
import { callEdgeFunction } from "../lib/functions";

/**
 * Cash — money in and money out this week.
 *
 * RECEIVABLES: the ageing of what customers owe, who to chase (overdue by
 * the calendar, or later than their own learned habit), and Zoho's own
 * payment reminder on one click per invoice. CREDIT WATCH: customers over
 * (or near) their limit.
 *
 * PAYABLES: the proposed payment run — everything overdue plus bills due
 * within the horizon, grouped per vendor. Untick what shouldn't go, pick
 * the bank account and date, and "Record" posts the vendor payments in
 * Zoho. Amounts are re-validated server-side against the open bills.
 */

interface AgeingBucket { amount: number; count: number }
interface Ageing { buckets: { current: AgeingBucket; d1_30: AgeingBucket; d31_60: AgeingBucket; d61_90: AgeingBucket; d90_plus: AgeingBucket }; total: AgeingBucket }
interface OpenInvoiceLike { zoho_id: string; number: string; party_zoho_id: string; party_name: string; date: string; due_date: string | null; total: number; balance: number; currency: string | null }
interface ChaseItem { invoice: OpenInvoiceLike; days_overdue: number; days_late_vs_habit: number | null; score: number; reason: string; can_remind: boolean }
interface OverLimitRow { customer_zoho_id: string; customer_name: string; limit: number | null; outstanding: number; over: boolean; note: string }
interface RunBill { zoho_id: string; number: string; date: string; due_date: string | null; days_until_due: number | null; balance: number; pay_amount: number; currency: string | null }
interface RunGroup { vendor_zoho_id: string; vendor_name: string; bills: RunBill[]; total: number; currency: string | null; note: string | null }
interface BankAccount { zoho_id: string; name: string }

const money = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function CashPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Receivables.
  const [ageing, setAgeing] = useState<Ageing | null>(null);
  const [chase, setChase] = useState<ChaseItem[]>([]);
  const [overLimit, setOverLimit] = useState<OverLimitRow[]>([]);
  const [behavioursKnown, setBehavioursKnown] = useState(0);

  // Payables.
  const [groups, setGroups] = useState<RunGroup[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [horizon, setHorizon] = useState(7);
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [paidThrough, setPaidThrough] = useState("");
  const [ticked, setTicked] = useState<Record<string, boolean>>({}); // bill_id → include

  const loadCollections = useCallback(async () => {
    setBusy("collections");
    const res = await callEdgeFunction("cashflow", { action: "collections" });
    const body = res.body as { ok?: boolean; error?: string; ageing?: Ageing; chase?: ChaseItem[]; over_limit?: OverLimitRow[]; behaviours_known?: number };
    if (body.ok) {
      setAgeing(body.ageing ?? null);
      setChase(body.chase ?? []);
      setOverLimit(body.over_limit ?? []);
      setBehavioursKnown(body.behaviours_known ?? 0);
    } else setMessage(`Receivables not loaded: ${body.error ?? res.status}`);
    setBusy(null);
  }, []);

  const loadRun = useCallback(async () => {
    setBusy("run");
    const res = await callEdgeFunction("cashflow", { action: "payment_run" });
    const body = res.body as { ok?: boolean; error?: string; groups?: RunGroup[]; bank_accounts?: BankAccount[]; horizon_days?: number };
    if (body.ok) {
      setGroups(body.groups ?? []);
      setBankAccounts(body.bank_accounts ?? []);
      setHorizon(body.horizon_days ?? 7);
      const t: Record<string, boolean> = {};
      for (const g of body.groups ?? []) for (const b of g.bills) t[b.zoho_id] = true;
      setTicked(t);
    } else setMessage(`Payment run not loaded: ${body.error ?? res.status}`);
    setBusy(null);
  }, []);

  useEffect(() => { void loadCollections(); void loadRun(); }, [loadCollections, loadRun]);

  async function sendReminder(item: ChaseItem) {
    setBusy(`remind:${item.invoice.zoho_id}`); setMessage(null);
    const res = await callEdgeFunction("cashflow", { action: "send_reminder", invoice_id: item.invoice.zoho_id });
    const body = res.body as { ok?: boolean; error?: string; message?: string };
    setMessage(body.ok ? `Zoho sent its payment reminder for ${item.invoice.number} to ${item.invoice.party_name}.` : `Not sent: ${body.error ?? res.status}`);
    setBusy(null);
  }

  async function recordRun() {
    const payments = groups
      .map((g) => ({
        vendor_id: g.vendor_zoho_id,
        date: payDate,
        paid_through_account_id: paidThrough,
        bills: g.bills.filter((b) => ticked[b.zoho_id]).map((b) => ({ bill_id: b.zoho_id, amount_applied: b.pay_amount })),
      }))
      .filter((p) => p.bills.length > 0);
    if (!payments.length || !paidThrough) return;
    setBusy("record"); setMessage(null);
    const res = await callEdgeFunction("cashflow", { action: "record_payments", payments });
    const body = res.body as { ok?: boolean; recorded?: number; failed?: number; results?: Array<{ vendor_name?: string; ok: boolean; error?: string; zoho_payment_id?: string }> };
    const bits = (body.results ?? []).map((r) => (r.ok ? `${r.vendor_name}: paid (${r.zoho_payment_id})` : `${r.vendor_name ?? "?"}: ${r.error}`));
    setMessage(`${body.recorded ?? 0} payment(s) recorded${body.failed ? `, ${body.failed} refused` : ""}. ${bits.join(" · ")}`);
    setBusy(null);
    await loadRun();
    await loadCollections();
  }

  const tickedCount = Object.values(ticked).filter(Boolean).length;
  const tickedTotal = groups.reduce((t, g) => t + g.bills.filter((b) => ticked[b.zoho_id]).reduce((s, b) => s + b.pay_amount, 0), 0);
  const b = ageing?.buckets;

  return (
    <main className="connections-layout">
      <div className="pane-heading">
        <h2>Cash</h2>
        <button type="button" className="btn ghost btn-small" disabled={busy != null} onClick={() => { void loadCollections(); void loadRun(); }}>
          {busy === "collections" || busy === "run" ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p className="muted connections-intro">
        Money in and money out this week. Chasing uses each customer's own payment habit where one is
        learned{behavioursKnown ? ` (${behavioursKnown} known)` : ""}; reminders and payments each take one click and are audited.
      </p>
      {message && <p className="muted bank-notice">{message}</p>}

      {/* ------------------------------------------------ receivables */}
      <section className="panel connection-card">
        <h3>Receivables — who owes what</h3>
        {b && (
          <div className="conn-kind-grid">
            {[["Not yet due", b.current], ["1–30 days", b.d1_30], ["31–60", b.d31_60], ["61–90", b.d61_90], ["Over 90", b.d90_plus]].map(([label, bk]) => (
              <div key={label as string} className="conn-kind-tile" style={{ cursor: "default" }}>
                <span className="conn-kind-count" style={{ color: label !== "Not yet due" && (bk as AgeingBucket).amount > 0 ? "var(--warn)" : undefined }}>{money((bk as AgeingBucket).amount)}</span>
                <span className="conn-kind-label">{label as string} ({(bk as AgeingBucket).count})</span>
              </div>
            ))}
          </div>
        )}

        <h3 style={{ marginTop: 16 }}>Who to chase this week</h3>
        {chase.length === 0 ? (
          <p className="muted">Nobody — nothing is overdue and nobody is past their own usual payment habit.</p>
        ) : (
          <ul className="conn-entity-list">
            {chase.map((c) => (
              <li key={c.invoice.zoho_id} style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <strong>{c.invoice.party_name}</strong> · {c.invoice.number} · {money(c.invoice.balance)} {c.invoice.currency ?? ""}
                  <div className="muted" style={{ marginTop: 4 }}>{c.reason}</div>
                </div>
                {c.can_remind ? (
                  <button type="button" className="btn btn-small" disabled={busy != null} onClick={() => void sendReminder(c)}>
                    {busy === `remind:${c.invoice.zoho_id}` ? "Sending…" : "Send Zoho's reminder"}
                  </button>
                ) : (
                  <span className="status-pill status-pending">nudge by hand</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {overLimit.length > 0 && (
          <>
            <h3 style={{ marginTop: 16 }}>Credit watch</h3>
            <ul className="conn-entity-list">
              {overLimit.map((r) => (
                <li key={r.customer_zoho_id}>
                  <div>
                    <strong>{r.customer_name}</strong>
                    <div className="muted">{r.note}</div>
                  </div>
                  <span className={`status-pill ${r.over ? "status-needs_review" : "status-pending"}`}>{r.over ? "over limit" : "near limit"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* -------------------------------------------------- payables */}
      <section className="panel connection-card">
        <h3>Payables — this week's payment run</h3>
        <p className="muted">
          Everything overdue plus bills due within {horizon} days, grouped per vendor. Untick what
          shouldn't go. Recording creates the vendor payments in Zoho Books — it does not move money at the bank.
        </p>
        {groups.length === 0 ? (
          <p className="muted">Nothing due within the horizon — no bills to pay this week.</p>
        ) : (
          <>
            {groups.map((g) => (
              <div key={g.vendor_zoho_id} className="bank-line" style={{ marginTop: 10 }}>
                <strong>{g.vendor_name}</strong> · {money(g.total)} {g.currency ?? ""}
                {g.note && <div className="muted" style={{ marginTop: 4, color: "var(--warn)" }}>{g.note}</div>}
                <table className="data-table" style={{ marginTop: 6 }}>
                  <tbody>
                    {g.bills.map((bill) => (
                      <tr key={bill.zoho_id}>
                        <td><input type="checkbox" checked={!!ticked[bill.zoho_id]} onChange={(e) => setTicked({ ...ticked, [bill.zoho_id]: e.target.checked })} /></td>
                        <td>{bill.number}</td>
                        <td className="muted">{bill.due_date ?? bill.date}{bill.days_until_due != null && bill.days_until_due < 0 ? ` · ${-bill.days_until_due}d overdue` : ""}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(bill.pay_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
              <select value={paidThrough} onChange={(e) => setPaidThrough(e.target.value)}>
                <option value="">Pay from…</option>
                {bankAccounts.map((a) => <option key={a.zoho_id} value={a.zoho_id}>{a.name}</option>)}
              </select>
              <label className="muted">Date <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></label>
              <button type="button" className="btn btn-small" disabled={busy != null || !paidThrough || tickedCount === 0} onClick={() => void recordRun()}>
                {busy === "record" ? "Recording…" : `Record ${tickedCount} bill payment(s) · ${money(tickedTotal)}`}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
