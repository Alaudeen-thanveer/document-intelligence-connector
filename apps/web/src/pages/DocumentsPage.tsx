import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { DocumentGrid } from "../components/DocumentGrid";
import { DocumentOverlay } from "../components/DocumentOverlay";
import { ReviewPanel } from "../components/ReviewPanel";
import { UploadInvoice } from "../components/UploadInvoice";
import { useDocumentDetail } from "../hooks/useDocumentDetail";
import { useDocuments } from "../hooks/useDocuments";
import type { AppOutletContext } from "../layout/AppLayout";
import { supabase } from "../lib/supabase";

export function DocumentsPage() {
  const { reviewerName } = useOutletContext<AppOutletContext>();
  const { documents, loading, error, reload } = useDocuments();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failedJudgmentIds, setFailedJudgmentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [tick, setTick] = useState(0);
  const [rulesVersion, setRulesVersion] = useState(0);

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

  const party =
    selected?.vendor_raw || selected?.customer_raw || "Document";

  return (
    <main className="dg-page">
      <div className="dg-head">
        <h2>Documents</h2>
        <span className="live-dot">Realtime</span>
        <span className="dg-head-sp" />
        <UploadInvoice
          onUploaded={(documentId) => {
            setSelectedId(documentId);
            refresh();
          }}
        />
      </div>

      {error && (
        <p className="error-text">
          {error}. Apply the migrations and ensure Supabase is running.
        </p>
      )}

      <DocumentGrid
        documents={documents}
        selectedId={selectedId}
        onOpen={setSelectedId}
        failedJudgmentIds={failedJudgmentIds}
        loading={loading}
      />

      <DocumentOverlay
        open={selectedId !== null}
        title={party}
        subtitle={
          selected
            ? `${selected.invoice_number ?? selected.id.slice(0, 8)} · ${selected.status}`
            : undefined
        }
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
