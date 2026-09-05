import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { invoiceStoragePath } from "../lib/storagePath";
import { supabase } from "../lib/supabase";

/**
 * The page a document came from, beside the record made from it.
 *
 * PDFs render here, a page at a time, drawn by pdf.js onto a canvas. The
 * earlier attempt embedded the PDF in an <iframe>, which handed it to the
 * browser's own plugin and wedged the renderer hard enough to need the tab
 * killed. Drawing it ourselves is plain JavaScript: nothing is handed off,
 * and it is also the only way to get page navigation, which a bill of
 * several pages needs.
 *
 * The bucket is private, so the URL is signed the same way the review panel's
 * own file link was — including its fallback for rows that store a bare
 * company/uuid-filename path rather than a full URL.
 */
/**
 * pdf.js is ~440kB and is only needed once a document is open, so it is
 * fetched then rather than shipped in the bundle everyone downloads to look
 * at the grid.
 */
type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist").then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).href;
    return mod;
  });
  return pdfjsPromise;
}

const SIGNED_FOR_SECONDS = 60 * 30;
/** Re-sign only once the link is genuinely old, not on every window focus. */
const RESIGN_AFTER_MS = 1000 * 60 * 20;
/**
 * A page is drawn at the reader's device pixel ratio so it stays sharp, but
 * 300% on a retina screen would ask for tens of millions of pixels. Browsers
 * refuse somewhere above this and hand back a blank canvas.
 */
const MAX_CANVAS_PIXELS = 16_000_000;

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
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);

  const signedAt = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const taskRef = useRef<RenderTask | null>(null);
  const [pdfVersion, setPdfVersion] = useState(0);
  /** Re-render on a resize, so "Fit" keeps meaning fit. */
  const [stageWidth, setStageWidth] = useState(0);

  // --- 1. sign -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    // Per-run, not a component ref: a component-level guard made a document
    // switch mid-request bail out of the new run and strand the pane.
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
    setPage(1);
    setPageCount(0);
    setZoom(100);
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

  // --- 2. open the document ------------------------------------------------
  useEffect(() => {
    if (!url || !isPdf) return;
    let cancelled = false;
    let loading: ReturnType<PdfJs["getDocument"]> | null = null;

    void loadPdfJs().then((pdfjs) => {
      if (cancelled) return;
      loading = pdfjs.getDocument({ url });
      loading.promise.then(
        (doc) => {
          if (cancelled) return;
          pdfRef.current = doc;
          setPageCount(doc.numPages);
          setPage(1);
          setPdfVersion((n) => n + 1);
        },
        (e: unknown) => {
          if (cancelled) return;
          setError(
            e instanceof Error
              ? `Could not read the PDF: ${e.message}`
              : "Could not read the PDF.",
          );
        },
      );
    });

    return () => {
      cancelled = true;
      taskRef.current?.cancel();
      taskRef.current = null;
      pdfRef.current = null;
      setPageCount(0);
      // destroy() belongs to the loading task, not the document proxy: it
      // aborts the outstanding fetches and tears down the worker with it.
      void loading?.destroy();
    };
  }, [url, isPdf]);

  /** The pane's usable width, read live rather than remembered. */
  function availableWidth(): number {
    const el = stageRef.current;
    if (!el) return 0;
    const cs = getComputedStyle(el);
    return Math.max(
      0,
      el.clientWidth -
        parseFloat(cs.paddingLeft || "0") -
        parseFloat(cs.paddingRight || "0"),
    );
  }

  // --- 3. keep "fit" meaning fit ------------------------------------------
  // The observer only nudges a re-draw when the pane changes size; the width
  // used for drawing is measured at draw time. Relying on the observer for the
  // FIRST measurement left the canvas at its default 300x150 whenever the
  // observer had not fired yet — which is every time the tab is not visible.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      setStageWidth(Math.round(entries[0]?.contentRect.width ?? 0));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- 4. draw -------------------------------------------------------------
  useEffect(() => {
    const doc = pdfRef.current;
    const canvas = canvasRef.current;
    const width = availableWidth();
    if (!doc || !canvas || hidden || width <= 0) return;

    let cancelled = false;

    void (async () => {
      try {
        const p = await doc.getPage(page);
        if (cancelled) return;

        // Fit the pane's width first, then apply the reader's zoom on top, so
        // 100% means "as wide as the pane" rather than an arbitrary size.
        const unit = p.getViewport({ scale: 1 });
        const fit = width / unit.width;
        let scale = fit * (zoom / 100);

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pixels =
          unit.width * scale * dpr * unit.height * scale * dpr;
        if (pixels > MAX_CANVAS_PIXELS) {
          scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        }

        const viewport = p.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

        taskRef.current?.cancel();
        const render = p.render({ canvas, viewport });
        taskRef.current = render;
        await render.promise;
        if (!cancelled) {
          taskRef.current = null;
          // Which page these pixels actually are, as opposed to which page the
          // label claims. Cheap, and the difference between the two is exactly
          // the bug this viewer had.
          canvas.dataset.page = String(page);
        }
      } catch (e) {
        // Cancelling a render is how this component changes page; it is not a
        // failure and must not be shown as one.
        const name = (e as { name?: string } | null)?.name;
        if (!cancelled && name !== "RenderingCancelledException") {
          setError(
            e instanceof Error
              ? `Could not draw the page: ${e.message}`
              : "Could not draw the page.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      taskRef.current?.cancel();
    };
  }, [pdfVersion, page, zoom, stageWidth, hidden]);

  const step = useCallback(
    (delta: number) => {
      setPage((p) => Math.min(Math.max(1, p + delta), Math.max(1, pageCount)));
    },
    [pageCount],
  );

  if (hidden) return null;

  const showPages = Boolean(url) && isPdf && !error && pageCount > 1;
  const canZoom = Boolean(url) && !error;

  return (
    <div className="dv">
      <div className="dv-stage" ref={stageRef}>
        {!fileUrl ? (
          <p className="dv-msg">This document has no file.</p>
        ) : error ? (
          <p className="dv-msg">{error}</p>
        ) : !url ? (
          <p className="dv-msg">Opening the page…</p>
        ) : isPdf ? (
          <div className="dv-paper">
            <canvas ref={canvasRef} className="dv-canvas" />
            {pageCount === 0 ? <p className="dv-msg">Reading the PDF…</p> : null}
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
          max={300}
          value={zoom}
          aria-label="Zoom the page"
          disabled={!canZoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
        <button
          type="button"
          className="dv-z"
          onClick={() => setZoom((z) => Math.min(300, z + 15))}
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

        {showPages ? (
          <span className="dv-pages">
            <button
              type="button"
              className="dv-z"
              onClick={() => step(-1)}
              disabled={page <= 1}
              aria-label="Previous page of this document"
            >
              &lsaquo;
            </button>
            <span className="dv-pageno">
              Page {page} of {pageCount}
            </span>
            <button
              type="button"
              className="dv-z"
              onClick={() => step(1)}
              disabled={page >= pageCount}
              aria-label="Next page of this document"
            >
              &rsaquo;
            </button>
          </span>
        ) : null}

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
