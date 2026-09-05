import { useRef, useState } from "react";
import { callEdgeFunction } from "../lib/functions";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

export interface UploadNotice {
  text: string;
  tone: "ok" | "bad";
}

interface Props {
  onUploaded: (documentId: string) => void;
  /** Where what-just-happened is said. The grid puts it in its status line. */
  onStatus: (notice: UploadNotice | null) => void;
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

/**
 * One button, on the same line as the pipeline tabs. It used to be a card
 * with a title and a line of explanation, which took a whole band of the
 * page to say what the button already says.
 */
export function UploadInvoice({ onUploaded, onStatus }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    onStatus(null);

    if (!ALLOWED_TYPES.has(file.type)) {
      onStatus({ text: "Use a PDF or an image (PNG, JPG, WEBP).", tone: "bad" });
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      onStatus({ text: "That file is over 50MB.", tone: "bad" });
      return;
    }

    setBusy(true);
    try {
      onStatus({ text: `Reading ${file.name}…`, tone: "ok" });
      const fileBase64 = await fileToBase64(file);
      const ingest = await callEdgeFunction("ingest", {
        source: "upload",
        filename: file.name,
        content_type: file.type,
        file_base64: fileBase64,
      });
      if (!ingest.ok) {
        // Only suggest the server is down when nothing answered. A status
        // the function itself returned is a real answer, and appending
        // "is functions:serve running?" to it sends the reader after the
        // wrong thing — a lapsed API subscription reads as a dead server.
        const said = ingest.body.error ?? ingest.body.reason ?? ingest.status;
        const nothingAnswered = [0, 404, 502, 503, 504].includes(ingest.status);
        throw new Error(
          nothingAnswered
            ? `Could not reach the ingest function (${ingest.status}). Is "npm run functions:serve" running?`
            : `Ingest failed: ${said}`,
        );
      }

      const documentId = String(ingest.body.document_id ?? "");
      if (!documentId) throw new Error("Ingest returned no document_id");

      const fields = (ingest.body.extract as { fields?: Record<string, unknown> } | undefined)
        ?.fields;
      const vendor = (fields?.vendor_raw as string | undefined) ?? "not read";
      onStatus({ text: `${file.name} is in — read as ${vendor}.`, tone: "ok" });
      onUploaded(documentId);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      // A thrown fetch means nothing was listening at all.
      const text =
        err instanceof TypeError
          ? 'Could not reach the ingest function. Is "npm run functions:serve" running?'
          : err instanceof Error
            ? err.message
            : String(err);
      onStatus({ text, tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn primary btn-small"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "Uploading…" : "Upload documents"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,image/png,image/jpeg,image/webp,application/pdf"
        hidden
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
    </>
  );
}
