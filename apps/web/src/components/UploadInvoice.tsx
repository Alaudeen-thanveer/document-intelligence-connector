import { useRef, useState } from "react";
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
          status: "needs_review",
          doc_type: "invoice",
        })
        .select("id")
        .single();

      if (insertError || !doc) {
        throw new Error(insertError?.message ?? "Failed to create document row");
      }

      setMessage(`Uploaded ${file.name}`);
      onUploaded(doc.id as string);
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
          <p className="upload-hint">PDF or image → Storage + documents row</p>
        </div>
        <button
          type="button"
          className="btn primary upload-btn"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Uploading…" : "Choose file"}
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
