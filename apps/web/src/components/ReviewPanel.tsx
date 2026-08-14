import { useEffect, useState } from "react";
import { callEdgeFunction } from "../lib/functions";
import { supabase } from "../lib/supabase";
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
  const [zohoBillId, setZohoBillId] = useState<string | null>(null);

  useEffect(() => {
    setVendorRaw(extracted?.vendor_raw ?? "");
    setTotalAmount(
      extracted?.total_amount != null ? String(extracted.total_amount) : "",
    );
    setInvoiceDate(extracted?.invoice_date ?? "");
    setActionMsg(null);
    setZohoBillId(null);
  }, [extracted, document?.id]);

  useEffect(() => {
    if (!document?.id) return;
    let cancelled = false;
    void supabase
      .from("erp_sync_log")
      .select("external_doc_id")
      .eq("document_id", document.id)
      .eq("source_type", "push")
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setZohoBillId(
            data?.external_doc_id != null ? String(data.external_doc_id) : null,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [document?.id, document?.status]);

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

  async function runExtractAndJudgment() {
    if (!document) return;
    setBusy("process");
    setActionMsg(null);
    try {
      const extract = await callEdgeFunction("extract", {
        document_id: document.id,
      });
      if (!extract.ok) {
        setActionMsg(
          `Extract failed: ${
            extract.body.error ?? extract.body.reason ?? extract.status
          }. Ensure functions serve is running.`,
        );
        setBusy(null);
        return;
      }
      const judgment = await callEdgeFunction("judgment", {
        document_id: document.id,
      });
      if (!judgment.ok) {
        setActionMsg(
          `Judgment failed: ${
            judgment.body.error ?? judgment.body.reason ?? judgment.status
          }`,
        );
        setBusy(null);
        onChanged();
        return;
      }
      setActionMsg(
        "Extract + judgment finished. Fields and rules should appear below.",
      );
      onChanged();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : String(err));
    }
    setBusy(null);
  }

  async function approve() {
    if (!extracted) {
      setActionMsg(
        "Cannot approve: run extract first (no extracted_fields for this document).",
      );
      return;
    }
    if (!vendorRaw.trim() || totalAmount.trim() === "") {
      setActionMsg(
        "Fill Vendor and Total amount, then Approve → Zoho. Empty fields cannot create a Zoho bill.",
      );
      return;
    }
    const amountNum = Number(totalAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setActionMsg("Total amount must be a positive number.");
      return;
    }

    setBusy("approve");
    setActionMsg(null);
    const name = reviewerName.trim() || "reviewer";
    // Zoho bill mapping requires a date; default to today when OCR left it blank.
    const dateForPush =
      invoiceDate.trim() || new Date().toISOString().slice(0, 10);

    // Persist form values before push — zoho-push reads DB, not the UI inputs.
    const { error: saveError } = await supabase
      .from("extracted_fields")
      .update({
        vendor_raw: vendorRaw.trim(),
        total_amount: amountNum,
        invoice_date: dateForPush,
      })
      .eq("id", extracted.id);
    if (saveError) {
      setActionMsg(`Could not save fields before push: ${saveError.message}`);
      setBusy(null);
      return;
    }
    if (!invoiceDate.trim()) setInvoiceDate(dateForPush);

    const alreadyApproved =
      document!.status === "approved" || document!.status === "synced";

    // Re-push path: status already approved after a failed Zoho call.
    if (!alreadyApproved) {
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
    }

    try {
      const push = await callEdgeFunction("zoho-push", {
        document_id: document!.id,
        expense_category:
          (import.meta.env.VITE_ZOHO_EXPENSE_CATEGORY as string | undefined) ??
          undefined,
      });
      if (!push.ok) {
        const detail = String(
          push.body.error ?? push.body.reason ?? push.status,
        );
        const gatewayHint =
          push.status === 502 ||
          /invalid response|upstream/i.test(detail)
            ? " Edge Functions runtime was down or restarting — keep `npx supabase functions serve --env-file .env` running, then click Approve → Zoho again."
            : "";
        setActionMsg(
          `Approved in app, but Zoho push failed: ${detail}.${gatewayHint} Status stays approved until a successful push sets synced.`,
        );
      } else {
        const attachOk = Boolean(
          (push.body.attachment as { present_on_bill?: boolean } | undefined)
            ?.present_on_bill,
        );
        const billId = String(push.body.external_doc_id ?? "");
        setZohoBillId(billId || null);
        setActionMsg(
          `Pushed to Zoho. Bill ${billId}` +
            (attachOk ? " — attachment present." : " — attachment not confirmed.") +
            " Check Zoho Books → Bills, or Studio table erp_sync_log.",
        );
      }
    } catch {
      setActionMsg(
        "Approved in app. Zoho push function is not reachable — start `npx supabase functions serve --env-file .env`, then click Approve → Zoho again.",
      );
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
        <div>
          <dt>Zoho bill</dt>
          <dd>{zohoBillId ?? (document.status === "synced" ? "synced (see erp_sync_log)" : "—")}</dd>
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
          <div>
            <p className="muted">
              No extracted_fields yet — upload alone does not read the invoice.
              Run extract (needs Mindee + functions serve).
            </p>
            <button
              type="button"
              className="btn primary"
              style={{ marginTop: "0.75rem" }}
              disabled={!!busy}
              onClick={() => void runExtractAndJudgment()}
            >
              {busy === "process" ? "Processing…" : "Run extract + judgment"}
            </button>
          </div>
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
          disabled={!!busy || !extracted || document.status === "synced"}
          onClick={() => void approve()}
        >
          {busy === "approve"
            ? "Pushing…"
            : document.status === "approved" && !zohoBillId
              ? "Retry Zoho push"
              : "Approve → Zoho"}
        </button>
      </div>

      {actionMsg && <p className="action-msg">{actionMsg}</p>}
    </div>
  );
}
