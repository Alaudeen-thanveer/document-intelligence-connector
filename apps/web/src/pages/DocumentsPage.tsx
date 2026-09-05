import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { DocumentGrid } from "../components/DocumentGrid";
import type { EditableField } from "../components/DocumentGrid";
import { DocumentOverlay } from "../components/DocumentOverlay";
import { ReviewPanel } from "../components/ReviewPanel";
import { UploadInvoice } from "../components/UploadInvoice";
import type { UploadNotice } from "../components/UploadInvoice";
import { useDocumentDetail } from "../hooks/useDocumentDetail";
import { useDocuments } from "../hooks/useDocuments";
import type { AppOutletContext } from "../layout/AppLayout";
import { supabase } from "../lib/supabase";
import type { DocumentRow } from "../types";

export function DocumentsPage() {
  const { reviewerName } = useOutletContext<AppOutletContext>();
  const { documents, loading, error, reload } = useDocuments();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failedJudgmentIds, setFailedJudgmentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const [rulesVersion, setRulesVersion] = useState(0);
  const [uploadNotice, setUploadNotice] = useState<UploadNotice | null>(null);

  const selected = useMemo(
    () => documents.find((d) => d.id === selectedId) ?? null,
    [documents, selectedId],
  );
  const detail = useDocumentDetail(selectedId, tick);

  useEffect(() => {
    let cancelled = false;

    async function loadFailed() {
      const { data } = await supabase
        .from("judgment_results")
        .select("document_id")
        .eq("passed", false);

      if (cancelled) return;
      setFailedJudgmentIds(new Set((data ?? []).map((r) => r.document_id)));
    }

    void loadFailed();

    const channel = supabase
      .channel("judgment-flags")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "judgment_results" },
        () => {
          void loadFailed();
          setTick((n) => n + 1);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, []);

  // Keep ReviewPanel in sync if rules were edited on /rules this session.
  useEffect(() => {
    function onRulesChanged() {
      setRulesVersion((n) => n + 1);
    }
    window.addEventListener("dic-rules-changed", onRulesChanged);
    return () => window.removeEventListener("dic-rules-changed", onRulesChanged);
  }, []);

  function refresh() {
    void reload();
    setTick((n) => n + 1);
  }

  /**
   * A cell edit corrects what was read off the page. That is a different act
   * from deciding the document is right, so it writes the one field on the
   * current extraction and stops: status stays where the pipeline put it, no
   * check is re-run, and nothing is pushed to Zoho.
   */
  async function saveField(
    row: DocumentRow,
    field: EditableField,
    value: string | number | null,
  ) {
    if (!row.extracted_fields_id) {
      throw new Error("Nothing has been read off this document yet.");
    }
    const { error: updateError } = await supabase
      .from("extracted_fields")
      .update({ [field]: value })
      .eq("id", row.extracted_fields_id);

    if (updateError) throw new Error(updateError.message);

    refresh();
    if (row.id === selectedId) setTick((n) => n + 1);
  }

  /**
   * The ready tick is the reviewer's own decision, kept apart from what the
   * pipeline did. It writes ready_at and ready_by and nothing else.
   */
  async function toggleReady(row: DocumentRow) {
    const patch = row.ready_at
      ? { ready_at: null, ready_by: null }
      : {
          ready_at: new Date().toISOString(),
          ready_by: reviewerName.trim() || "reviewer",
        };

    const { error: updateError } = await supabase
      .from("documents")
      .update(patch)
      .eq("id", row.id);

    if (updateError) throw new Error(updateError.message);
    refresh();
  }

  // Prev/Next walks the queue the user is looking at, not every document.
  //
  // The document can leave that queue while it is open — approving it moves it
  // to Posted, ticking it ready moves it to Ready to post — and then its index
  // is -1 and both buttons go dead, stranding the reviewer mid-pile. So the
  // last place it held is remembered, and stepping continues from there.
  const at = selectedId ? visibleIds.indexOf(selectedId) : -1;
  const lastAt = useRef(0);
  if (at >= 0) lastAt.current = at;
  const from = at >= 0 ? at : Math.min(lastAt.current, visibleIds.length - 1);
  const canPrev = visibleIds.length > 0 && (at > 0 || (at < 0 && from >= 0));
  const canNext =
    visibleIds.length > 0 &&
    (at >= 0 ? at < visibleIds.length - 1 : from < visibleIds.length);

  function step(delta: number) {
    if (visibleIds.length === 0) return;
    // When the open document has left the list, the row that slid into its
    // place is the natural "next", so stepping forward stays put and
    // stepping back goes to the one before.
    const to = at >= 0 ? at + delta : delta > 0 ? from : from - 1;
    if (to < 0 || to >= visibleIds.length) return;
    setSelectedId(visibleIds[to]);
  }

  const failed = selected ? failedJudgmentIds.has(selected.id) : false;
  const state: { tone: "good" | "hold" | "quiet"; label: string } | undefined =
    !selected
      ? undefined
      : selected.status === "synced"
        ? { tone: "good", label: `In Zoho Books${selected.zoho_bill_id ? ` — ${selected.zoho_bill_id}` : ""}` }
        : failed
          ? { tone: "hold", label: "Held by a failed check — posting needs a written override" }
          : (selected.checks_total ?? 0) > 0 &&
              selected.checks_passed === selected.checks_total
            ? { tone: "good", label: "Every check passed" }
            : { tone: "quiet", label: `Checks: ${selected.checks_passed ?? 0} of ${selected.checks_total ?? 0}` };

  const party =
    selected?.vendor_raw || selected?.customer_raw || "Document";

  return (
    <main className="dg-page">
      {error && (
        <p className="error-text">
          {error}. Apply the migrations and ensure Supabase is running.
        </p>
      )}

      <DocumentGrid
        documents={documents}
        selectedId={selectedId}
        onOpen={setSelectedId}
        onVisible={setVisibleIds}
        onSaveField={saveField}
        onToggleReady={toggleReady}
        failedJudgmentIds={failedJudgmentIds}
        loading={loading}
        notice={uploadNotice}
        actions={
          <UploadInvoice
            onStatus={setUploadNotice}
            onUploaded={(documentId) => {
              setSelectedId(documentId);
              refresh();
            }}
          />
        }
      />

      <DocumentOverlay
        open={selectedId !== null}
        title={party}
        subtitle={
          selected
            ? `${selected.invoice_number ?? selected.id.slice(0, 8)} · ${selected.status}`
            : undefined
        }
        fileUrl={selected?.file_url}
        state={state}
        hasPrev={canPrev}
        hasNext={canNext}
        onStep={step}
        onClose={() => setSelectedId(null)}
      >
        <ReviewPanel
          document={selected}
          extracted={detail.extracted}
          judgments={detail.judgments}
          loading={detail.loading}
          error={detail.error}
          reviewerName={reviewerName}
          rulesVersion={rulesVersion}
          onChanged={refresh}
        />
      </DocumentOverlay>
    </main>
  );
}
