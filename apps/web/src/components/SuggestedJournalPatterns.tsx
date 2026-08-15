import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

/**
 * "Repeating manual journals" — journals the accountant posts by hand every
 * month without a Zoho recurring definition (bk_journal_patterns). Enable
 * makes month-end watch for it (due vs posted). Nothing is created in Zoho;
 * the accountant may also choose to set it up as a proper recurring journal
 * there. Dismiss records the decision.
 */

interface PatternRow {
  id: string;
  fingerprint: string;
  label: string;
  cadence: string;
  monthly_coverage: number;
  expected_day_min: number | null;
  expected_day_max: number | null;
  amount_median: number | null;
  amount_cv: number | null;
  sample_size: number;
  first_seen: string | null;
  last_seen: string | null;
  recurring_note: string | null;
  example_journal_ids: string[];
  status: "proposed" | "enabled" | "dismissed" | "stale";
}

interface Props {
  reviewerName: string;
}

const CADENCE_LABEL: Record<string, string> = {
  fixed_recurring: "fixed amount, monthly",
  variable_recurring: "monthly, varying amount",
  irregular: "irregular",
  insufficient: "too few to tell",
};

export function SuggestedJournalPatterns({ reviewerName }: Props) {
  const [rows, setRows] = useState<PatternRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("bk_journal_patterns")
      .select(
        "id, fingerprint, label, cadence, monthly_coverage, expected_day_min, expected_day_max, amount_median, amount_cv, sample_size, first_seen, last_seen, recurring_note, example_journal_ids, status",
      )
      .eq("status", "proposed")
      .in("cadence", ["fixed_recurring", "variable_recurring"])
      .gte("sample_size", 3)
      .order("sample_size", { ascending: false });
    if (error) setMsg(error.message);
    setRows((data ?? []) as PatternRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(p: PatternRow, status: "enabled" | "dismissed") {
    setBusyId(p.id);
    setMsg(null);
    const who = reviewerName.trim() || "reviewer";
    const { error } = await supabase
      .from("bk_journal_patterns")
      .update({ status, decided_by: who, decided_at: new Date().toISOString() })
      .eq("id", p.id);
    setMsg(
      error
        ? `Could not update: ${error.message}`
        : status === "enabled"
          ? `Month-end will now watch for “${p.label}” each month.`
          : `Dismissed “${p.label}”. Nothing enabled.`,
    );
    setBusyId(null);
    await load();
  }

  return (
    <div className="section suggested-rules">
      <div className="suggested-head">
        <div>
          <h3>Repeating manual journals</h3>
          <p className="muted">
            Journals posted by hand every month that are not set up as Zoho
            recurring journals. Enable one and month-end will flag it when it
            has not been posted for the period. Nothing is created in Zoho.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">
          No repeating manual journals detected — run “Learn from history”
          above, or every pattern has been decided.
        </p>
      ) : (
        <ul className="rules-list">
          {rows.map((p) => (
            <li key={p.id} className="suggested-item">
              <div className="suggested-row">
                <span className="rules-vendor" title={p.label}>
                  {p.label}
                </span>
                <span className="suggested-claim">
                  <span className="muted">
                    {CADENCE_LABEL[p.cadence] ?? p.cadence}
                    {p.amount_median != null ? ` · ~${p.amount_median}` : ""}
                    {p.expected_day_min != null
                      ? ` · around day ${p.expected_day_min}–${p.expected_day_max}`
                      : ""}
                    {" · "}
                    {p.sample_size} times, {p.first_seen} → {p.last_seen}
                    {p.recurring_note ? ` · “${p.recurring_note}”` : ""}
                  </span>
                </span>
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
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="action-msg">{msg}</p>}
    </div>
  );
}
