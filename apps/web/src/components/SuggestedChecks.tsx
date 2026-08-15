import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

/**
 * "Suggested checks" — per-vendor judgment checks that the learned
 * recurrence cadence justifies (bk_check_proposals). A proposal has no
 * effect on any document until a human clicks Enable; that click is the
 * ONLY path to status = 'enabled', which is the only status the judgment
 * engine will ever consult. Dismiss records the decision.
 */

interface ProposalRow {
  id: string;
  company_id: string;
  party_kind: "vendor" | "customer";
  party_zoho_id: string;
  party_name: string;
  check_kind:
    | "recurring_twice_in_period"
    | "amount_anomaly"
    | "expected_missing"
    | "supporting_document_strictness"
    | "later_than_usual";
  rationale: string;
  params: Record<string, unknown>;
  status: "proposed" | "enabled" | "dismissed" | "stale";
}

interface RhythmRow {
  party_zoho_id: string;
  cadence: string;
  monthly_coverage: number;
  sample_size: number;
  confidence: number;
}

interface Props {
  kind: "vendor" | "customer";
  reviewerName: string;
}

const KIND_LABEL: Record<ProposalRow["check_kind"], string> = {
  recurring_twice_in_period: "Twice in one month",
  amount_anomaly: "Amount out of range",
  expected_missing: "Expected but missing",
  supporting_document_strictness: "Supporting document strictness",
  later_than_usual: "Open longer than usual (month-end)",
};

const CADENCE_LABEL: Record<string, string> = {
  fixed_recurring: "fixed monthly",
  variable_recurring: "monthly, varying amount",
  irregular: "irregular",
  insufficient: "too few to tell",
};

export function SuggestedChecks({ kind, reviewerName }: Props) {
  const [rows, setRows] = useState<ProposalRow[]>([]);
  const [rhythms, setRhythms] = useState<Record<string, RhythmRow>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [pRes, rRes] = await Promise.all([
      supabase
        .from("bk_check_proposals")
        .select(
          "id, company_id, party_kind, party_zoho_id, party_name, check_kind, rationale, params, status",
        )
        .eq("party_kind", kind)
        .eq("status", "proposed")
        .order("party_name"),
      supabase
        .from("bk_rhythms")
        .select("party_zoho_id, cadence, monthly_coverage, sample_size, confidence")
        .eq("party_kind", kind),
    ]);
    setRows(pRes.error ? [] : ((pRes.data ?? []) as ProposalRow[]));
    const map: Record<string, RhythmRow> = {};
    for (const r of (rRes.data ?? []) as RhythmRow[]) map[r.party_zoho_id] = r;
    setRhythms(map);
    if (pRes.error) setMsg(pRes.error.message);
    setLoading(false);
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(p: ProposalRow, status: "enabled" | "dismissed") {
    setBusyId(p.id);
    setMsg(null);
    const who = reviewerName.trim() || "reviewer";
    const { error } = await supabase
      .from("bk_check_proposals")
      .update({ status, decided_by: who, decided_at: new Date().toISOString() })
      .eq("id", p.id);
    if (error) {
      setMsg(`Could not update: ${error.message}`);
    } else {
      setMsg(
        status === "enabled"
          ? `Enabled “${KIND_LABEL[p.check_kind]}” for ${p.party_name}.`
          : `Dismissed “${KIND_LABEL[p.check_kind]}” for ${p.party_name}. Nothing enabled.`,
      );
    }
    setBusyId(null);
    await load();
  }

  // Group by party for a compact display.
  const byParty = new Map<string, ProposalRow[]>();
  for (const r of rows) {
    const list = byParty.get(r.party_zoho_id) ?? [];
    list.push(r);
    byParty.set(r.party_zoho_id, list);
  }

  return (
    <div className="section suggested-rules">
      <div className="suggested-head">
        <div>
          <h3>Suggested checks</h3>
          <p className="muted">
            Per-{kind} checks justified by how often and how much this party
            bills. None run until you enable them.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : byParty.size === 0 ? (
        <p className="muted">
          No pending check suggestions — run “Learn from history” above, or
          every proposal has been decided.
        </p>
      ) : (
        <ul className="rules-list">
          {[...byParty.entries()].map(([partyId, list]) => {
            const rh = rhythms[partyId];
            return (
              <li key={partyId} className="suggested-item">
                <div className="suggested-row">
                  <span className="rules-vendor" title={list[0].party_name}>
                    {list[0].party_name}
                  </span>
                  <span className="suggested-claim muted">
                    {rh
                      ? `${CADENCE_LABEL[rh.cadence] ?? rh.cadence} · ${
                        Math.round(rh.monthly_coverage * 100)
                      }% of months · ${rh.sample_size} bills · confidence ${
                        Math.round(rh.confidence * 100)
                      }%`
                      : ""}
                  </span>
                  <span />
                </div>
                {list.map((p) => (
                  <div key={p.id} className="suggested-check-row">
                    <div>
                      <strong>
                        {KIND_LABEL[p.check_kind]}
                        {p.check_kind === "supporting_document_strictness" &&
                          typeof p.params.strictness === "string" && (
                          <> → {p.params.strictness}</>
                        )}
                      </strong>
                      <span className="muted"> — {p.rationale}</span>
                    </div>
                    <span className="rule-actions">
                      <button
                        type="button"
                        className="btn ghost btn-small"
                        disabled={busyId === p.id}
                        onClick={() => void decide(p, "dismissed")}
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        className="btn primary btn-small"
                        disabled={busyId === p.id}
                        onClick={() => void decide(p, "enabled")}
                      >
                        Enable
                      </button>
                    </span>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      )}
      {msg && <p className="action-msg">{msg}</p>}
    </div>
  );
}
