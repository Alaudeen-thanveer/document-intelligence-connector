import { useEffect, useState } from "react";
import { functionsUrl, supabase } from "../lib/supabase";
import type {
  DocumentRow,
  ExtractedFieldsRow,
  JudgmentResultRow,
} from "../types";
import { isFlaggedStatus } from "../types";

interface Props {
  document: DocumentRow | null;
  extracted: ExtractedFieldsRow | null;
  judgments: JudgmentResultRow[];
  loading: boolean;
  error: string | null;
  reviewerName: string;
  onChanged: () => void;
}

export function ReviewPanel({
  document,
  extracted,
  judgments,
  loading,
  error,
  reviewerName,
  onChanged,
}: Props) {
  const [vendorRaw, setVendorRaw] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    setVendorRaw(extracted?.vendor_raw ?? "");
    setTotalAmount(
      extracted?.total_amount != null ? String(extracted.total_amount) : "",
    );
    setInvoiceDate(extracted?.invoice_date ?? "");
    setActionMsg(null);
  }, [extracted]);

  if (!document) {
    return (
      <div className="panel empty-panel">
        <h2>Review</h2>
        <p>Select a document to inspect judgment failures or unresolved matches.</p>
      </div>
    );
  }

  const failedRules = judgments.filter((j) => !j.passed);
  const entityUnresolvedHint =
    isFlaggedStatus(document.status) &&
    failedRules.length === 0 &&
    document.status === "needs_review";

  async function correct() {
    if (!extracted) {
      setActionMsg("No extracted fields to correct.");
      return;
    }
    setBusy("correct");
    setActionMsg(null);
    const { error: updateError } = await supabase
      .from("extracted_fields")
      .update({
        vendor_raw: vendorRaw.trim() || null,
        total_amount: totalAmount === "" ? null : Number(totalAmount),
        invoice_date: invoiceDate || null,
      })
      .eq("id", extracted.id);

    if (updateError) {
      setActionMsg(updateError.message);
      setBusy(null);
      return;
    }

    await supabase
      .from("documents")
      .update({ status: "needs_review" })
      .eq("id", document!.id);

    setActionMsg("Corrections saved. Approve when ready to push.");
    setBusy(null);
    onChanged();
  }

  async function approve() {
    setBusy("approve");
    setActionMsg(null);
    const name = reviewerName.trim() || "reviewer";

    for (const row of failedRules) {
      const { error: judgmentError } = await supabase
        .from("judgment_results")
        .update({
          passed: true,
          notes: `${row.notes ?? ""}${row.notes ? " | " : ""}Approved by ${name}`,
          reviewed_by: name,
        })
        .eq("id", row.id);
      if (judgmentError) {
        setActionMsg(judgmentError.message);
        setBusy(null);
        return;
      }
    }

    // Record an explicit review approval when the flag was entity-unresolved only.
    if (failedRules.length === 0) {
      await supabase.from("judgment_results").insert({
        document_id: document!.id,
        rule_name: "human_review_approval",
        passed: true,
        notes: "Reviewer approved for Zoho push",
        reviewed_by: name,
      });
    }

    const { error: statusError } = await supabase
      .from("documents")
      .update({ status: "approved" })
      .eq("id", document!.id);

    if (statusError) {
      setActionMsg(statusError.message);
      setBusy(null);
      return;
    }

    // Best-effort push; UI still succeeds if the function is not running.
    try {
      const res = await fetch(`${functionsUrl}/zoho-push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ document_id: document!.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        setActionMsg(
          `Approved. Push skipped or failed: ${body.error ?? body.reason ?? res.status}`,
        );
      } else {
        setActionMsg(`Approved and pushed. Zoho bill ${body.external_doc_id}`);
      }
    } catch {
      setActionMsg("Approved. Zoho push function is not reachable yet.");
    }

    setBusy(null);
    onChanged();
  }

  async function reject() {
    setBusy("reject");
    setActionMsg(null);
    const name = reviewerName.trim() || "reviewer";

    const { error: insertError } = await supabase.from("judgment_results").insert({
      document_id: document!.id,
      rule_name: "human_review_rejection",
      passed: false,
      notes: "Rejected by reviewer before Zoho push",
      reviewed_by: name,
    });
    if (insertError) {
      setActionMsg(insertError.message);
      setBusy(null);
      return;
    }

    const { error: statusError } = await supabase
      .from("documents")
      .update({ status: "rejected" })
      .eq("id", document!.id);

    if (statusError) {
      setActionMsg(statusError.message);
      setBusy(null);
      return;
    }

    setActionMsg("Document rejected.");
    setBusy(null);
    onChanged();
  }

  return (
    <div className="panel review-panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Selected document</p>
          <h2>{document.doc_type ?? "Document"}</h2>
        </div>
        <span className={`status-pill status-${document.status}`}>
          {document.status}
        </span>
      </header>

      <dl className="meta-grid">
        <div>
          <dt>Source</dt>
          <dd>{document.source}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>
            {document.confidence != null
              ? Number(document.confidence).toFixed(2)
              : "—"}
          </dd>
        </div>
        <div>
          <dt>File</dt>
          <dd className="truncate">
            <a href={document.file_url} target="_blank" rel="noreferrer">
              Open file
            </a>
          </dd>
        </div>
      </dl>

      {loading && <p className="muted">Loading review details…</p>}
      {error && <p className="error-text">{error}</p>}

      <section className="section">
        <h3>Judgment failures</h3>
        {failedRules.length === 0 ? (
          <p className="muted">No failed judgment rules.</p>
        ) : (
          <ul className="rule-list">
            {failedRules.map((rule) => (
              <li key={rule.id}>
                <strong>{rule.rule_name}</strong>
                <span>{rule.notes || "No notes"}</span>
              </li>
            ))}
          </ul>
        )}
        {entityUnresolvedHint && (
          <p className="warn-banner">
            Entity match unresolved — vendor and/or GL account could not be
            auto-matched with enough confidence. Correct fields below, then
            approve for push.
          </p>
        )}
      </section>

      <section className="section">
        <h3>Correct extracted fields</h3>
        {!extracted ? (
          <p className="muted">No extracted_fields row for this document.</p>
        ) : (
          <div className="form-grid">
            <label>
              Vendor
              <input
                value={vendorRaw}
                onChange={(e) => setVendorRaw(e.target.value)}
              />
            </label>
            <label>
              Total amount
              <input
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <label>
              Invoice date
              <input
                type="date"
                value={invoiceDate ?? ""}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </label>
          </div>
        )}
      </section>

      <div className="actions">
        <button
          type="button"
          className="btn ghost"
          disabled={!!busy || !extracted}
          onClick={() => void correct()}
        >
          {busy === "correct" ? "Saving…" : "Correct"}
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={!!busy}
          onClick={() => void reject()}
        >
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!!busy}
          onClick={() => void approve()}
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
      </div>

      {actionMsg && <p className="action-msg">{actionMsg}</p>}
    </div>
  );
}
