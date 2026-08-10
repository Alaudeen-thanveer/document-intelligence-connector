import type { DocumentRow } from "../types";
import { isFlaggedStatus } from "../types";

interface Props {
  documents: DocumentRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  failedJudgmentIds: Set<string>;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function DocumentList({
  documents,
  selectedId,
  onSelect,
  failedJudgmentIds,
}: Props) {
  if (documents.length === 0) {
    return (
      <div className="empty-state">
        <p>No documents yet.</p>
        <span>Inbound triage will show up here in realtime.</span>
      </div>
    );
  }

  return (
    <ul className="doc-list">
      {documents.map((doc) => {
        const flagged =
          isFlaggedStatus(doc.status) || failedJudgmentIds.has(doc.id);
        const selected = doc.id === selectedId;

        return (
          <li key={doc.id}>
            <button
              type="button"
              className={`doc-row ${selected ? "selected" : ""} ${flagged ? "flagged" : ""}`}
              onClick={() => onSelect(doc.id)}
            >
              <div className="doc-row-top">
                <span className="doc-id">{shortId(doc.id)}</span>
                <span className={`status-pill status-${doc.status}`}>
                  {doc.status}
                </span>
              </div>
              <div className="doc-row-meta">
                <span>{doc.doc_type ?? "untyped"}</span>
                <span>{doc.source}</span>
                <span>{formatWhen(doc.uploaded_at)}</span>
              </div>
              {flagged && <span className="flag-hint">Needs attention</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
