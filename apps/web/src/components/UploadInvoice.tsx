import { useRef, useState } from "react";
import { callEdgeFunction } from "../lib/functions";
import { supabase } from "../lib/supabase";

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

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
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
      const path = `${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
      const { error: uploadError } = await supabase.storage
        .from("invoices")
        .upload(path, file, {
          cacheControl: "3600",
          upsert: false,
          contentType: file.type,
        });

      if (uploadError) {
        throw new Error(uploadError.message);
      }

      const { data: publicData } = supabase.storage
        .from("invoices")
        .getPublicUrl(path);

      const fileUrl = publicData.publicUrl;
      if (!fileUrl) {
        throw new Error("Could not build public file URL");
      }

      const { data: doc, error: insertError } = await supabase
        .from("documents")
        .insert({
          source: "upload",
          file_url: fileUrl,
          status: "uploaded",
          doc_type: "invoice",
          has_supporting_document: true,
        })
        .select("id")
        .single();

      if (insertError || !doc) {
        throw new Error(insertError?.message ?? "Failed to create document row");
      }

      const documentId = doc.id as string;
      setMessage(`Uploaded ${file.name}. Running extract…`);

      const extract = await callEdgeFunction("extract", {
        document_id: documentId,
      });
      if (!extract.ok) {
        throw new Error(
          `Extract failed: ${
            extract.body.error ?? extract.body.reason ?? extract.status
          }. Is "npx supabase functions serve --env-file .env" running?`,
        );
      }

      setMessage(`Extracted. Running judgment…`);
      const judgment = await callEdgeFunction("judgment", {
        document_id: documentId,
      });
      if (!judgment.ok) {
        throw new Error(
          `Judgment failed: ${
            judgment.body.error ?? judgment.body.reason ?? judgment.status
          }`,
        );
      }

      const vendor =
        (extract.body.fields as { vendor_raw?: string } | undefined)
          ?.vendor_raw ?? "—";
      const amount =
        (extract.body.fields as { total_amount?: number } | undefined)
          ?.total_amount ?? "—";
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
            Upload → extract → judgment (needs functions serve)
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
