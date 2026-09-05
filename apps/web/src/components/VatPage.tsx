import { useState } from "react";
import { callEdgeFunction } from "../lib/functions";
import { shortDate } from "../lib/dates";

/**
 * VAT — the Form 201 boxes recomputed from the period's documents in Zoho
 * Books, and what to look at before filing.
 *
 * This REVIEWS. Filing happens in the FTA portal and nothing here submits
 * anything; the point is that the numbers you type into the portal have been
 * derived from the documents rather than trusted from a report.
 *
 * It was a section on Month-end, gated behind that page's own check having
 * run first — so the VAT review was hidden behind an unrelated load. It is
 * also a different job: Month-end is a closing checklist, this is a return.
 *
 * The boxes are numbered as the FTA numbers them, because the person reading
 * this is about to copy them into a form that uses those numbers.
 */
interface EmirateBox {
  amount: number;
  vat: number;
  count: number;
}

interface VatCheck {
  name: string;
  passed: boolean;
  note: string;
  docs: string[];
}

interface VatForm {
  period: { start: string; end: string };
  boxes: {
    standard_by_emirate: Record<string, EmirateBox>;
    standard_total: EmirateBox;
    reverse_charge_supplies: EmirateBox;
    zero_rated: EmirateBox;
    exempt: EmirateBox;
    outputs_total: EmirateBox;
    inputs_standard: EmirateBox;
    inputs_reverse_charge: EmirateBox;
    inputs_total: EmirateBox;
    net_vat: number;
  };
  out_of_scope: EmirateBox;
  checks: VatCheck[];
  due_date: string;
  days_left: number;
  ready: boolean;
}

const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

/** The emirate keys come back as slugs; the form prints them as names. */
function emirate(key: string): string {
  return key
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function Row({
  box,
  label,
  amount,
  vat,
  strong,
  quiet,
}: {
  box?: string;
  label: string;
  amount: number | null;
  vat: number | null;
  strong?: boolean;
  quiet?: boolean;
}) {
  return (
    <tr className={quiet ? "vat-quiet" : undefined}>
      <td className="vat-box">{box ?? ""}</td>
      <td>{strong ? <strong>{label}</strong> : label}</td>
      <td className="num">{strong ? <strong>{money(amount)}</strong> : money(amount)}</td>
      <td className="num">{strong ? <strong>{money(vat)}</strong> : money(vat)}</td>
    </tr>
  );
}

export function VatPage() {
  const [form, setForm] = useState<VatForm | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await callEdgeFunction("vat-review", {});
      const body = res.body as {
        ok?: boolean;
        error?: string;
        period_label?: string;
        form?: VatForm;
      };
      if (body.ok && body.form) {
        setForm(body.form);
        setLabel(body.period_label ?? "");
      } else {
        setError(body.error ?? "The VAT review did not come back.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The VAT review did not come back.");
    } finally {
      setBusy(false);
    }
  }

  const b = form?.boxes;
  const failed = (form?.checks ?? []).filter((c) => !c.passed);

  return (
    <main className="connections-layout">
      <div className="pane-heading">
        <h2>VAT</h2>
        <button type="button" className="btn ghost btn-small" disabled={busy} onClick={() => void run()}>
          {busy ? "Reading the period's documents…" : form ? "Run it again" : "Run the review"}
        </button>
      </div>
      <p className="muted connections-intro">
        The Form 201 boxes, recomputed from the period's documents in Zoho Books
        rather than taken from a report. Filing stays in the FTA portal — nothing
        here is submitted.
      </p>

      {error && <p className="error-text">{error}</p>}

      {!form && !busy && !error && (
        <p className="empty-panel">
          Nothing computed yet. Running the review reads every document in the
          period from Zoho, so it is done on request rather than on arrival.
        </p>
      )}

      {form && b && (
        <>
          <section className="panel connection-card">
            <div className="vat-head">
              <div>
                <p className="eyebrow">Period</p>
                <h3>{label || `${shortDate(form.period.start)} — ${shortDate(form.period.end)}`}</h3>
              </div>
              <div className="vat-due">
                <span className="vat-due-1">Due {shortDate(form.due_date)}</span>
                <span className={`vat-due-2${form.days_left < 0 ? " late" : ""}`}>
                  {form.days_left >= 0
                    ? `${form.days_left} days left`
                    : `${-form.days_left} days overdue`}
                </span>
              </div>
              <span
                className={`status-pill ${form.ready ? "status-synced" : "status-needs_review"}`}
              >
                {form.ready ? "Every check passed" : `${failed.length} to look at`}
              </span>
            </div>
          </section>

          <section className="panel connection-card">
            <h3>The return</h3>
            <div className="tablewrap">
              <table className="data-table vat-table">
                <thead>
                  <tr>
                    <th className="vat-box">Box</th>
                    <th>What</th>
                    <th className="num">Amount</th>
                    <th className="num">VAT</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(b.standard_by_emirate).map(([key, v], i) => (
                    <Row
                      key={key}
                      box={`1${String.fromCharCode(97 + i)}`}
                      label={`Standard-rated supplies — ${emirate(key)}`}
                      amount={v.amount}
                      vat={v.vat}
                    />
                  ))}
                  {/* A subtotal of nothing reads as a stray first row. */}
                  {Object.keys(b.standard_by_emirate).length > 1 ? (
                    <Row
                      label="Standard-rated supplies, all emirates"
                      amount={b.standard_total.amount}
                      vat={b.standard_total.vat}
                      quiet
                    />
                  ) : null}
                  {Object.keys(b.standard_by_emirate).length === 0 ? (
                    <Row
                      box="1"
                      label="Standard-rated supplies — none this period"
                      amount={0}
                      vat={0}
                    />
                  ) : null}
                  <Row
                    box="3"
                    label="Reverse-charge supplies (imports, declared as output)"
                    amount={b.reverse_charge_supplies.amount}
                    vat={b.reverse_charge_supplies.vat}
                  />
                  <Row box="4" label="Zero-rated supplies" amount={b.zero_rated.amount} vat={null} />
                  <Row box="5" label="Exempt supplies" amount={b.exempt.amount} vat={null} />
                  <Row
                    box="8"
                    label="Totals — output"
                    amount={b.outputs_total.amount}
                    vat={b.outputs_total.vat}
                    strong
                  />
                  <Row
                    box="9"
                    label="Standard-rated expenses (recoverable)"
                    amount={b.inputs_standard.amount}
                    vat={b.inputs_standard.vat}
                  />
                  <Row
                    box="10"
                    label="Reverse-charge supplies (recovered as input)"
                    amount={b.inputs_reverse_charge.amount}
                    vat={b.inputs_reverse_charge.vat}
                  />
                  <Row
                    box="11"
                    label="Totals — input"
                    amount={b.inputs_total.amount}
                    vat={b.inputs_total.vat}
                    strong
                  />
                  <Row
                    box="14"
                    label={`Net VAT ${b.net_vat >= 0 ? "payable" : "recoverable"}`}
                    amount={null}
                    vat={Math.abs(b.net_vat)}
                    strong
                  />
                </tbody>
              </table>
            </div>
            <p className="vat-sum">
              Box 14 = {money(b.standard_total.vat)} (standard output) +{" "}
              {money(b.reverse_charge_supplies.vat)} (reverse charge) &minus;{" "}
              {money(b.inputs_total.vat)} (input) ={" "}
              <strong>{money(b.net_vat)}</strong>
              {b.net_vat < 0 ? " — recoverable, so shown positive above." : "."}
            </p>
            {b.inputs_reverse_charge.vat !== 0 && (
              <p className="muted">
                Box 3 and box 10 are the two halves of the same reverse charge:
                declared as output, recovered as input. They cancel in box 14
                unless the input is not fully recoverable.
              </p>
            )}
          </section>

          {form.out_of_scope.count > 0 && (
            <section className="panel connection-card">
              <h3>Not on the return</h3>
              <p className="muted">
                {form.out_of_scope.count} document
                {form.out_of_scope.count === 1 ? "" : "s"} totalling{" "}
                {money(form.out_of_scope.amount)} are out of scope, so they
                appear in no box. Listed so the period's documents can be
                accounted for in full.
              </p>
            </section>
          )}

          <section className="panel connection-card">
            <h3>Before you file</h3>
            <ul className="conn-entity-list vat-checks">
              {form.checks.map((c) => (
                <li key={c.name}>
                  <div>
                    <strong className={c.passed ? "vat-ok" : "vat-bad"}>
                      {c.passed ? "Passed" : "Look at this"} — {c.name.replace(/_/g, " ")}
                    </strong>
                    <div className="muted">
                      {c.note}
                      {c.docs.length > 0 && c.docs.length <= 5
                        ? ` — ${c.docs.join("; ")}`
                        : c.docs.length > 5
                          ? ` — ${c.docs.length} documents`
                          : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
