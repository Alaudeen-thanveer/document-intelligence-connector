import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { DocumentList } from "../components/DocumentList";
import { ReviewPanel } from "../components/ReviewPanel";
import { UploadInvoice } from "../components/UploadInvoice";
import { useDocumentDetail } from "../hooks/useDocumentDetail";
import { useDocuments } from "../hooks/useDocuments";
import type { AppOutletContext } from "../layout/AppLayout";
import { supabase } from "../lib/supabase";

const DOC_SELECT =
  "id, source, file_url, status, uploaded_at, doc_type, confidence, zoho_bill_id";

export function DocumentsPage() {
  const { reviewerName } = useOutletContext<AppOutletContext>();
  const { documents, loading, error, setDocuments } = useDocuments();
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

  return (
    <main className="layout">
      <section className="list-pane">
        <div className="pane-heading">
          <h2>Documents</h2>
          <span className="live-dot">Realtime</span>
        </div>
        <UploadInvoice
          onUploaded={(documentId) => {
            setSelectedId(documentId);
            void supabase
              .from("documents")
              .select(DOC_SELECT)
              .order("uploaded_at", { ascending: false })
              .then(({ data }) => {
                if (data) setDocuments(data);
              });
            setTick((n) => n + 1);
          }}
        />
        {loading && <p className="muted">Loading documents…</p>}
        {error && (
          <p className="error-text">
            {error}. Apply the review policies migration and ensure Supabase
            is running.
          </p>
        )}
        <div className="doc-list-scroll">
          <DocumentList
            documents={documents}
            selectedId={selectedId}
            onSelect={setSelectedId}
            failedJudgmentIds={failedJudgmentIds}
          />
        </div>
      </section>

      <ReviewPanel
        document={selected}
        extracted={detail.extracted}
        judgments={detail.judgments}
        loading={detail.loading}
        error={detail.error}
        reviewerName={reviewerName}
        rulesVersion={rulesVersion}
        onChanged={() => {
          void supabase
            .from("documents")
            .select(DOC_SELECT)
            .order("uploaded_at", { ascending: false })
            .then(({ data }) => {
              if (data) setDocuments(data);
            });
          setTick((n) => n + 1);
        }}
      />
    </main>
  );
}
