import { useCallback, useEffect, useState } from "react";
import { callEdgeFunction } from "../lib/functions";

/**
 * Month-end — nudges to look at before closing a period: recurring
 * journals due vs posted, and expected bills that have not arrived (only
 * for vendors whose expected-missing check a reviewer enabled).
 * This page lists; it never posts anything.
 */

interface Nudge {
  kind:
    | "recurring_journal_due"
    | "recurring_journal_posted"
    | "expected_bill_missing"
    | "expected_bill_arrived";
  severity: "info" | "attention";
  title: string;
  detail: string;
  key: string;
}

interface MonthEndResult {
  ok: boolean;
  month: string;
  today: string;
  summary: {
    recurring_journal_definitions: number;
    journals_posted_this_month: number;
    expected_bill_checks_enabled: number;
    needs_attention: number;
  };
  nudges: Nudge[];
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

export function MonthEndPage() {
  const [month, setMonth] = useState(currentMonth());
  const [result, setResult] = useState<MonthEndResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const attention = result?.nudges.filter((n) => n.severity === "attention") ?? [];
  const info = result?.nudges.filter((n) => n.severity === "info") ?? [];

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
        Things to look at before closing the period. Nothing here posts to
        Zoho — it only tells you what is due, what has been done, and what
        has not arrived.
      </p>

      {error && <p className="error-text">{error}</p>}

      {result && (
        <div className="conn-kind-grid">
          <div className="conn-kind-tile" style={{ cursor: "default" }}>
            <span className="conn-kind-count" style={{ color: attention.length ? "var(--warn)" : undefined }}>
              {result.summary.needs_attention}
            </span>
            <span className="conn-kind-label">Need attention</span>
          </div>
          <div className="conn-kind-tile" style={{ cursor: "default" }}>
            <span className="conn-kind-count">{result.summary.recurring_journal_definitions}</span>
            <span className="conn-kind-label">Recurring journals defined</span>
          </div>
          <div className="conn-kind-tile" style={{ cursor: "default" }}>
            <span className="conn-kind-count">{result.summary.journals_posted_this_month}</span>
            <span className="conn-kind-label">Journals posted this month</span>
          </div>
          <div className="conn-kind-tile" style={{ cursor: "default" }}>
            <span className="conn-kind-count">{result.summary.expected_bill_checks_enabled}</span>
            <span className="conn-kind-label">Vendors watched for expected bills</span>
          </div>
        </div>
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
                    {n.kind === "recurring_journal_due" ? "journal due" : "bill missing"}
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
