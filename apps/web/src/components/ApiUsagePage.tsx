import { useCallback, useEffect, useState } from "react";
import { callEdgeFunction } from "../lib/functions";

/**
 * Admin — Zoho API usage. Zoho sends no rate-limit headers, so the app
 * meters its own calls (zoho_api_calls). Limits are Zoho's published
 * per-plan numbers, matched to the org's plan read live from Zoho.
 */

interface UsageResult {
  ok: boolean;
  org: { name: string | null; plan_name: string; plan_key: string; plan_error: string | null };
  limits: { per_minute: number; per_day: number | null; concurrent: number; source: string; note: string };
  usage: {
    calls_last_minute: number;
    calls_today: number;
    rate_limited_today: number;
    pct_of_daily: number | null;
    pct_of_minute: number;
  };
  per_action_today: Array<{ action: string; calls_today: number; clicks_today: number; calls_per_click: number; rate_limited: number; avg_ms: number }>;
  per_endpoint_today: Array<{ endpoint: string; calls: number }>;
  per_day: Array<{ day: string; calls: number; rate_limited: number }>;
  recent_clicks: Array<{ action_id: string; action: string; actor: string | null; at: string; calls: number; rate_limited: number; endpoints: number }>;
  window_days: number;
  generated_at: string;
  error?: string;
}

const ACTION_LABEL: Record<string, string> = {
  sync: "Sync from Zoho",
  learn: "Learn from history",
  push: "Post to Zoho",
  "month-end": "Month-end check",
  extract: "Extract",
  judgment: "Judgment",
  "usage-dashboard": "This dashboard",
  probe: "Probe",
  "bank-ingest": "Bank: read statement",
  "bank-suggest": "Bank: re-suggest",
  "bank-push": "Bank: post to Zoho",
};

function pct(n: number | null): string {
  return n == null ? "—" : `${n}%`;
}

export function ApiUsagePage() {
  const [data, setData] = useState<UsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(7);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    setError(null);
    const res = await callEdgeFunction("api-usage", { window_days: days });
    if (!res.ok || (res.body as { ok?: boolean }).ok === false) {
      setError(String((res.body as { error?: string }).error ?? `Failed (${res.status}) — is functions serve running?`));
      setData(null);
    } else {
      setData(res.body as unknown as UsageResult);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(windowDays);
  }, [windowDays, load]);

  const dayMax = Math.max(1, ...(data?.per_day.map((d) => d.calls) ?? [1]));
  const dailyLimit = data?.limits.per_day ?? null;
  const dailyPct = data?.usage.pct_of_daily ?? null;
  const minutePct = data?.usage.pct_of_minute ?? 0;
  const tone = (p: number | null): string =>
    p == null ? "" : p >= 90 ? "usage-crit" : p >= 70 ? "usage-warn" : "usage-ok";

  return (
    <main className="connections-layout">
      <div className="pane-heading">
        <h2>API usage</h2>
        <div className="month-nav">
          {[7, 30].map((d) => (
            <button key={d} type="button" className={`btn ghost btn-small${windowDays === d ? " active-chip" : ""}`} onClick={() => setWindowDays(d)}>
              {d} days
            </button>
          ))}
          <button type="button" className="btn ghost btn-small" disabled={loading} onClick={() => void load(windowDays)}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>
      <p className="muted connections-intro">
        Every call this app makes to Zoho Books, counted per click, against the limits Zoho publishes for the org's plan. Zoho itself sends no usage headers, so this log is the counter.
      </p>

      {error && <p className="error-text">{error}</p>}

      {data && (
        <>
          <section className="panel connection-card">
            <header className="panel-header">
              <div>
                <p className="eyebrow">Zoho Books · {data.org.name ?? "org"}</p>
                <h2>Plan: {data.org.plan_name}</h2>
              </div>
              <span className={`status-pill ${data.usage.rate_limited_today > 0 ? "status-needs_review" : "status-synced"}`}>
                {data.usage.rate_limited_today > 0 ? `${data.usage.rate_limited_today} rate-limited today` : "no rate limits hit today"}
              </span>
            </header>
            {data.org.plan_error && <p className="error-text">Could not read plan from Zoho: {data.org.plan_error}</p>}

            <div className="usage-meters">
              <div className={`usage-meter ${tone(dailyPct)}`}>
                <div className="usage-meter-head">
                  <span>Today</span>
                  <strong>
                    {data.usage.calls_today.toLocaleString()} <span className="muted">/ {dailyLimit != null ? dailyLimit.toLocaleString() : "unknown plan"} per day</span>
                  </strong>
                </div>
                <div className="usage-bar"><i style={{ width: `${Math.min(100, dailyPct ?? 0)}%` }} /></div>
                <span className="muted">{pct(dailyPct)} of the daily allowance · resets at midnight UTC</span>
              </div>
              <div className={`usage-meter ${tone(minutePct)}`}>
                <div className="usage-meter-head">
                  <span>Last minute</span>
                  <strong>
                    {data.usage.calls_last_minute} <span className="muted">/ {data.limits.per_minute} per minute</span>
                  </strong>
                </div>
                <div className="usage-bar"><i style={{ width: `${Math.min(100, minutePct)}%` }} /></div>
                <span className="muted">{pct(minutePct)} of the per-minute allowance · same for every plan</span>
              </div>
              <div className="usage-meter">
                <div className="usage-meter-head">
                  <span>Concurrent</span>
                  <strong>{data.limits.concurrent} <span className="muted">at a time</span></strong>
                </div>
                <span className="muted">Zoho's soft limit for this plan tier</span>
              </div>
            </div>
            <p className="muted" style={{ fontSize: ".78rem" }}>
              Limits are fixed by Zoho per plan — <a href={data.limits.source} target="_blank" rel="noreferrer">published here</a>. Free 1,000/day · Standard 2,000 · Professional 5,000 · Premium/Elite/Ultimate 10,000 · 100/minute for all.
            </p>
          </section>

          <section className="panel connection-card">
            <h3>Calls per click, today</h3>
            <p className="muted" style={{ marginTop: 0 }}>What each user action costs in Zoho calls. One click can be many calls — a full sync is one call per master, a learn is one call per historical document.</p>
            {data.per_action_today.length === 0 ? (
              <p className="muted">No Zoho calls today yet.</p>
            ) : (
              <div className="tablewrap"><table className="usage-table">
                <thead><tr><th>Action</th><th className="num">Clicks</th><th className="num">Calls</th><th className="num">Calls / click</th><th className="num">Avg ms</th><th className="num">429s</th></tr></thead>
                <tbody>
                  {data.per_action_today.map((a) => (
                    <tr key={a.action}>
                      <td>{ACTION_LABEL[a.action] ?? a.action} <span className="muted">· {a.action}</span></td>
                      <td className="num">{a.clicks_today}</td>
                      <td className="num"><strong>{a.calls_today}</strong></td>
                      <td className="num">{a.calls_per_click}</td>
                      <td className="num">{a.avg_ms}</td>
                      <td className="num">{a.rate_limited > 0 ? <span className="error-text">{a.rate_limited}</span> : "0"}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>

          <div className="usage-two">
            <section className="panel connection-card">
              <h3>Per day, last {data.window_days} days</h3>
              {data.per_day.length === 0 ? (
                <p className="muted">Nothing in this window.</p>
              ) : (
                <div className="usage-days">
                  {data.per_day.map((d) => (
                    <div key={d.day} className="usage-day" title={`${d.day}: ${d.calls} calls${d.rate_limited ? `, ${d.rate_limited} rate-limited` : ""}`}>
                      <div className="usage-day-bar">
                        <i style={{ height: `${Math.round((d.calls / dayMax) * 100)}%` }} className={d.rate_limited ? "hit" : ""} />
                        {dailyLimit != null && d.calls > dailyLimit && <b>over</b>}
                      </div>
                      <span className="num">{d.calls}</span>
                      <small>{d.day.slice(5)}</small>
                    </div>
                  ))}
                </div>
              )}
              {dailyLimit != null && <p className="muted" style={{ fontSize: ".78rem" }}>Daily limit {dailyLimit.toLocaleString()}. Bars are relative to the busiest day shown.</p>}
            </section>

            <section className="panel connection-card">
              <h3>Busiest endpoints, today</h3>
              {data.per_endpoint_today.length === 0 ? (
                <p className="muted">—</p>
              ) : (
                <ul className="conn-entity-list">
                  {data.per_endpoint_today.map((e) => (
                    <li key={e.endpoint}><code style={{ fontSize: ".82rem" }}>{e.endpoint}</code><span className="num">{e.calls}</span></li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="panel connection-card">
            <h3>Recent clicks</h3>
            <p className="muted" style={{ marginTop: 0 }}>Each row is one user action and everything it triggered against Zoho.</p>
            {data.recent_clicks.length === 0 ? (
              <p className="muted">No clicks in this window.</p>
            ) : (
              <div className="tablewrap"><table className="usage-table">
                <thead><tr><th>When</th><th>Action</th><th>Who</th><th className="num">Zoho calls</th><th className="num">Endpoints</th><th className="num">429s</th></tr></thead>
                <tbody>
                  {data.recent_clicks.map((c) => (
                    <tr key={c.action_id}>
                      <td className="num">{new Date(c.at).toLocaleString()}</td>
                      <td>{ACTION_LABEL[c.action] ?? c.action}</td>
                      <td>{c.actor ?? "—"}</td>
                      <td className="num"><strong>{c.calls}</strong></td>
                      <td className="num">{c.endpoints}</td>
                      <td className="num">{c.rate_limited > 0 ? <span className="error-text">{c.rate_limited}</span> : "0"}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>
          <p className="muted" style={{ fontSize: ".76rem" }}>Generated {new Date(data.generated_at).toLocaleString()}. Loading this page itself costs one Zoho call (reading the plan) and appears above as “This dashboard”.</p>
        </>
      )}
    </main>
  );
}
