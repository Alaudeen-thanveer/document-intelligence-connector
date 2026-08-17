import { useRef, useState } from "react";
import { callEdgeFunction } from "../lib/functions";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

interface Props {
  onUploaded: (documentId: string) => void;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export function UploadInvoice({ onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | null | undefined) {
    if (!file) return;

    setError(null);
    setMessage(null);

    if (!ALLOWED_TYPES.has(file.type)) {
      setError("Use a PDF or image (PNG, JPG, WEBP).");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError("File must be 50MB or smaller.");
      return;
    }

    setBusy(true);
    try {
      setMessage(`Uploading ${file.name} via shared ingest…`);
      const fileBase64 = await fileToBase64(file);
      const ingest = await callEdgeFunction("ingest", {
        source: "upload",
        filename: file.name,
        content_type: file.type,
        file_base64: fileBase64,
      });
      if (!ingest.ok) {
        throw new Error(
          `Ingest failed: ${
            ingest.body.error ?? ingest.body.reason ?? ingest.status
          }. Is "npm run functions:serve" running?`,
        );
      }

      const documentId = String(ingest.body.document_id ?? "");
      if (!documentId) throw new Error("Ingest returned no document_id");

      const fields = (ingest.body.extract as { fields?: Record<string, unknown> } | undefined)
        ?.fields;
      const vendor = (fields?.vendor_raw as string | undefined) ?? "—";
      const amount = (fields?.total_amount as number | undefined) ?? "—";
      setMessage(
        `Ready for review: vendor=${vendor}, amount=${amount}. Select the doc to inspect fields / Approve → Zoho.`,
      );
      onUploaded(documentId);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="upload-box">
      <div className="upload-row">
        <div>
          <p className="upload-title">Upload invoice</p>
          <p className="upload-hint">
            Same ingest path as inbound email (needs functions serve)
          </p>
        </div>
        <button
          type="button"
          className="btn primary upload-btn"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Processing…" : "Choose file"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,image/png,image/jpeg,image/webp,application/pdf"
          hidden
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
      </div>
      {message && <p className="upload-ok">{message}</p>}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
