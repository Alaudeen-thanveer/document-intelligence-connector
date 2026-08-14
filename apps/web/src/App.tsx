import { useEffect, useMemo, useState } from "react";
import { DocumentList } from "./components/DocumentList";
import { ReviewPanel } from "./components/ReviewPanel";
import { UploadInvoice } from "./components/UploadInvoice";
import { useDocumentDetail } from "./hooks/useDocumentDetail";
import { useDocuments } from "./hooks/useDocuments";
import { supabase } from "./lib/supabase";

export default function App() {
  const { documents, loading, error, setDocuments } = useDocuments();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewerName, setReviewerName] = useState("reviewer");
  const [failedJudgmentIds, setFailedJudgmentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [tick, setTick] = useState(0);

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

  return (
    <div className="app-shell">
      <div className="atmosphere" aria-hidden="true" />
      <header className="topbar">
        <div>
          <p className="brand">Document Intelligence Connector</p>
          <h1>Document review</h1>
        </div>
        <label className="reviewer-field">
          Reviewer
          <input
            value={reviewerName}
            onChange={(e) => setReviewerName(e.target.value)}
            placeholder="Your name"
          />
        </label>
      </header>

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
                .select(
                  "id, source, file_url, status, uploaded_at, doc_type, confidence",
                )
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
          onChanged={() => {
            // Reload list from source of truth after mutations.
            void supabase
              .from("documents")
              .select(
                "id, source, file_url, status, uploaded_at, doc_type, confidence",
              )
              .order("uploaded_at", { ascending: false })
              .then(({ data }) => {
                if (data) setDocuments(data);
              });
            setTick((n) => n + 1);
          }}
        />
      </main>
    </div>
  );
}
