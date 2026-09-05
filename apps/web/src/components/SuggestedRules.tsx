import { useCallback, useEffect, useState } from "react";
import { callEdgeFunction } from "../lib/functions";
import { supabase } from "../lib/supabase";

/**
 * "Suggested from history" — proposals learned from the customer's Zoho
 * history (bk_party_profiles). Nothing here is a rule until a human clicks
 * Accept; that click is the ONLY path from a proposal to
 * vendor_account_rules / customer_account_rules. Dismiss records the
 * decision without creating anything.
 */

interface ProfileRow {
  id: string;
  company_id: string;
  party_kind: "vendor" | "customer";
  party_zoho_id: string;
  party_name: string;
  dominant_account_id: string | null;
  dominant_account_name: string | null;
  account_share: number | null;
  account_split: Array<{
    account_id: string;
    account_name: string;
    lines: number;
    share: number;
  }>;
  sample_size: number;
  line_sample_size: number;
  confidence: number;
  first_seen: string | null;
  last_seen: string | null;
  suggestion_status: "proposed" | "accepted" | "dismissed" | "stale";
}

interface LearnRun {
  status: string;
  bills_fetched: number;
  invoices_fetched: number;
  profiles_written: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

interface Props {
  kind: "vendor" | "customer";
  reviewerName: string;
  /** Parties that already have a real rule — proposals for them are hidden. */
  partyIdsWithRule: Set<string>;
  onAccepted: () => void;
}

const MIN_SAMPLE = 3;

function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

export function SuggestedRules({
  kind,
  reviewerName,
  partyIdsWithRule,
  onAccepted,
}: Props) {
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [lastRun, setLastRun] = useState<LearnRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [learning, setLearning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [profilesRes, runRes] = await Promise.all([
      supabase
        .from("bk_party_profiles")
        .select(
          "id, company_id, party_kind, party_zoho_id, party_name, dominant_account_id, dominant_account_name, account_share, account_split, sample_size, line_sample_size, confidence, first_seen, last_seen, suggestion_status",
        )
        .eq("party_kind", kind)
        .eq("suggestion_status", "proposed")
        .gte("sample_size", MIN_SAMPLE)
        .not("dominant_account_id", "is", null)
        .order("confidence", { ascending: false }),
      supabase
        .from("bk_learn_runs")
        .select(
          "status, bills_fetched, invoices_fetched, profiles_written, started_at, finished_at, error",
        )
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (profilesRes.error) {
      setMsg(profilesRes.error.message);
      setRows([]);
    } else {
      setRows((profilesRes.data ?? []) as ProfileRow[]);
    }
    setLastRun((runRes.data ?? null) as LearnRun | null);
    setLoading(false);
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function learn() {
    setLearning(true);
    setMsg(null);
    const res = await callEdgeFunction("bookkeeping-learn", {});
    if (!res.ok) {
      setMsg(
        String(
          res.body.error ??
            `Learning failed (${res.status}) — is functions serve running?`,
        ),
      );
    } else {
      const b = res.body as {
        documents_analyzed?: number;
        proposable?: number;
      };
      setMsg(
        `Read ${b.documents_analyzed ?? 0} historical documents; ${
          b.proposable ?? 0
        } proposal(s) ready for your review.`,
      );
    }
    await load();
    setLearning(false);
  }

  /** The one and only path from a proposal to a real rule. */
  async function accept(p: ProfileRow) {
    if (!p.dominant_account_id) return;
    setBusyId(p.id);
    setMsg(null);
    const who = reviewerName.trim() || "reviewer";
    const isVendor = p.party_kind === "vendor";
    const { error: ruleError } = isVendor
      ? await supabase.from("vendor_account_rules").upsert(
          {
            vendor_zoho_id: p.party_zoho_id,
            vendor_name: p.party_name,
            account_zoho_id: p.dominant_account_id,
            account_name: p.dominant_account_name ?? "",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "vendor_zoho_id" },
        )
      : await supabase.from("customer_account_rules").upsert(
          {
            customer_zoho_id: p.party_zoho_id,
            customer_name: p.party_name,
            account_zoho_id: p.dominant_account_id,
            account_name: p.dominant_account_name ?? "",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "customer_zoho_id" },
        );
    if (ruleError) {
      setMsg(`Could not accept: ${ruleError.message}`);
      setBusyId(null);
      return;
    }
    await Promise.all([
      supabase
        .from("bk_party_profiles")
        .update({
          suggestion_status: "accepted",
          decided_by: who,
          decided_at: new Date().toISOString(),
        })
        .eq("id", p.id),
      supabase.from("bk_suggestion_log").insert({
        company_id: p.company_id,
        party_kind: p.party_kind,
        party_zoho_id: p.party_zoho_id,
        field: "default_account",
        suggested_value: p.dominant_account_id,
        suggested_confidence: p.confidence,
        outcome: "accepted",
        final_value: p.dominant_account_id,
        decided_by: who,
      }),
    ]);
    setMsg(
      `Accepted: ${p.party_name} now defaults to ${p.dominant_account_name}.`,
    );
    setBusyId(null);
    await load();
    onAccepted();
  }

  async function dismiss(p: ProfileRow) {
    setBusyId(p.id);
    setMsg(null);
    const who = reviewerName.trim() || "reviewer";
    await Promise.all([
      supabase
        .from("bk_party_profiles")
        .update({
          suggestion_status: "dismissed",
          decided_by: who,
          decided_at: new Date().toISOString(),
        })
        .eq("id", p.id),
      supabase.from("bk_suggestion_log").insert({
        company_id: p.company_id,
        party_kind: p.party_kind,
        party_zoho_id: p.party_zoho_id,
        field: "default_account",
        suggested_value: p.dominant_account_id,
        suggested_confidence: p.confidence,
        outcome: "dismissed",
        decided_by: who,
      }),
    ]);
    setMsg(`Dismissed the suggestion for ${p.party_name}. No rule created.`);
    setBusyId(null);
    await load();
  }

  const visible = rows.filter((r) => !partyIdsWithRule.has(r.party_zoho_id));

  return (
    <div className="section suggested-rules">
      <div className="suggested-head">
        <div>
          <h3>Suggested from history</h3>
          <p className="muted">
            Learned from this company's Zoho Books history. Nothing here is a
            rule until you accept it.
            {lastRun && (
              <>
                {" "}
                Last learned{" "}
                {lastRun.finished_at
                  ? new Date(lastRun.finished_at).toLocaleString()
                  : "(running)"}
                {lastRun.status === "failed" && lastRun.error
                  ? ` — failed: ${lastRun.error}`
                  : ` — ${lastRun.bills_fetched} bills, ${lastRun.invoices_fetched} invoices read.`}
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          className="btn ghost btn-small"
          disabled={learning}
          onClick={() => void learn()}
        >
          {learning ? "Learning…" : lastRun ? "Learn again" : "Learn from history"}
        </button>
      </div>

      {loading ? (
        <p className="muted">Loading suggestions…</p>
      ) : visible.length === 0 ? (
        <p className="muted">
          {lastRun
            ? `No pending ${kind} suggestions — every proposal has been decided, or history has fewer than ${MIN_SAMPLE} documents per party.`
            : "Run “Learn from history” to propose rules from past bills and invoices."}
        </p>
      ) : (
        <ul className="rules-list">
          {visible.map((p) => {
            const split = p.account_split ?? [];
            const isSplit = split.length >= 2 && (p.account_share ?? 0) < 0.7;
            const open = expanded === p.id;
            return (
              <li key={p.id} className="suggested-item">
                <div className="suggested-row">
                  <span className="rules-vendor" title={p.party_name}>
                    {p.party_name}
                  </span>
                  <span className="suggested-claim">
                    → <strong>{p.dominant_account_name}</strong>
                    <span className="muted">
                      {" "}
                      {pct(p.account_share)} of {p.line_sample_size} lines ·{" "}
                      {p.sample_size} docs · confidence {pct(p.confidence)}
                    </span>
                  </span>
                  <span className="rule-actions">
                    <button
                      type="button"
                      className="btn ghost btn-small"
                      onClick={() => setExpanded(open ? null : p.id)}
                    >
                      {open ? "Hide" : "Evidence"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost btn-small"
                      disabled={busyId === p.id}
                      onClick={() => void dismiss(p)}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      className="btn primary btn-small"
                      disabled={busyId === p.id || isSplit}
                      title={
                        isSplit
                          ? "Split party — lines go to more than one account; needs line-level attention rather than one default"
                          : undefined
                      }
                      onClick={() => void accept(p)}
                    >
                      Accept
                    </button>
                  </span>
                </div>
                {isSplit && (
                  <p className="warn-banner suggested-split">
                    Split party: no single dominant account ({pct(p.account_share)}
                    ). Its invoices need per-line accounts rather than one
                    default — see evidence.
                  </p>
                )}
                {open && (
                  <div className="suggested-evidence">
                    <table>
                      <tbody>
                        {split.map((s) => (
                          <tr key={s.account_id}>
                            <td>{s.account_name}</td>
                            <td className="num">{s.lines} lines</td>
                            <td className="num">{pct(s.share)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="muted">
                      Seen {p.first_seen ?? "?"} → {p.last_seen ?? "?"}.
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {msg && <p className="action-msg">{msg}</p>}
    </div>
  );
}
