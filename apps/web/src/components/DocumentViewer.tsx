import { useEffect, useRef, useState } from "react";
import { invoiceStoragePath } from "../lib/storagePath";
import { supabase } from "../lib/supabase";

/**
 * The page a document came from, beside the record made from it.
 *
 * The bucket is private, so this signs a URL the same way the review panel's
 * own "Open file" does — including its fallback for rows that store a bare
 * company/uuid-filename path rather than a full URL.
 *
 * Images render inline and zoom. PDFs deliberately do NOT: an <iframe> around
 * a signed PDF hung the embedded browser's renderer hard enough to need the
 * tab killed, and a viewer that can lock the app is worse than a link. A PDF
 * gets a card and opens in a tab until this grows a real pdf.js viewer, which
 * is the only way to get page navigation anyway.
 */
const SIGNED_FOR_SECONDS = 60 * 30;
/** Re-sign only once the link is genuinely old, not on every window focus. */
const RESIGN_AFTER_MS = 1000 * 60 * 20;

function looksLikePdf(path: string | null, fileUrl: string): boolean {
  const s = (path ?? fileUrl).toLowerCase().split("?")[0];
  return s.endsWith(".pdf");
}

export function DocumentViewer({
  fileUrl,
  hidden,
}: {
  fileUrl: string | null | undefined;
  hidden: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [isPdf, setIsPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const signedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Per-run, NOT a component-level ref. A component-level guard meant that
    // switching documents while a signature was in flight made the new run
    // bail, the old run return on its own cancelled flag, and the pane sit on
    // "Opening the page…" for ever. StrictMode reproduced it every time.
    let inFlight = false;

    async function sign() {
      if (inFlight) return;
      inFlight = true;
      try {
        setError(null);
        if (!fileUrl) {
          setUrl(null);
          return;
        }

        const path = invoiceStoragePath(fileUrl);
        setIsPdf(looksLikePdf(path, fileUrl));

        if (!path) {
          // Not a storage object — an absolute URL we can use as-is.
          if (!cancelled) setUrl(fileUrl);
          return;
        }

        const { data, error: signError } = await supabase.storage
          .from("invoices")
          .createSignedUrl(path, SIGNED_FOR_SECONDS);

        if (cancelled) return;
        if (signError || !data?.signedUrl) {
          setUrl(null);
          setError(signError?.message ?? "Could not sign a link to the file.");
          return;
        }
        signedAt.current = Date.now();
        setUrl(data.signedUrl);
      } finally {
        inFlight = false;
      }
    }

    setUrl(null);
    signedAt.current = 0;
    void sign();

    function onFocus() {
      if (Date.now() - signedAt.current > RESIGN_AFTER_MS) void sign();
    }
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [fileUrl]);

  if (hidden) return null;

  const canZoom = Boolean(url) && !isPdf;

  return (
    <div className="dv">
      <div className="dv-stage">
        {!fileUrl ? (
          <p className="dv-msg">This document has no file.</p>
        ) : error ? (
          <p className="dv-msg">{error}</p>
        ) : !url ? (
          <p className="dv-msg">Opening the page…</p>
        ) : isPdf ? (
          <div className="dv-pdf">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 2.5h6l4 4v11H5z" />
              <path d="M11 2.5v4h4" />
            </svg>
            <p className="dv-pdf-1">This page is a PDF</p>
            <p className="dv-pdf-2">
              It opens in a tab for now; reading it here needs a real PDF
              viewer, which is also what page navigation would need.
            </p>
            <a
              className="btn btn-small primary"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open the page
            </a>
          </div>
        ) : (
          <img
            className="dv-img"
            src={url}
            alt="The page this document came from"
            style={{ width: `${zoom}%` }}
          />
        )}
      </div>

      <div className="dv-bar">
        <button
          type="button"
          className="dv-z"
          onClick={() => setZoom((z) => Math.max(40, z - 15))}
          aria-label="Zoom out"
          disabled={!canZoom}
        >
          &minus;
        </button>
        <input
          type="range"
          min={40}
          max={200}
          value={zoom}
          aria-label="Zoom the page"
          disabled={!canZoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
        <button
          type="button"
          className="dv-z"
          onClick={() => setZoom((z) => Math.min(200, z + 15))}
          aria-label="Zoom in"
          disabled={!canZoom}
        >
          +
        </button>
        <button
          type="button"
          className="btn btn-small ghost"
          onClick={() => setZoom(100)}
          disabled={!canZoom}
        >
          Fit
        </button>
        <span className="dv-sp" />
        {url ? (
          <a
            className="btn btn-small ghost"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in a tab
          </a>
        ) : null}
      </div>
    </div>
  );
}
