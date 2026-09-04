import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { DocumentViewer } from "./DocumentViewer";

/**
 * The document, opened: the page it came from on the left, everything the
 * record needs on the right. It leaves the queue showing at the left of the
 * window so you can still see where you are in the pile.
 *
 * The right column still holds today's ReviewPanel whole and unmodified —
 * splitting it into sections is the next slice, kept separate so it can be
 * reverted on its own.
 *
 * Portalled to <body>, like the settings drawer, so no ancestor's
 * backdrop-filter or transform can become the containing block for its
 * position:fixed surfaces.
 */
export function DocumentOverlay({
  open,
  title,
  subtitle,
  fileUrl,
  state,
  hasPrev,
  hasNext,
  onStep,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  fileUrl?: string | null;
  /** The standing state of the document, shown along the bottom. */
  state?: { tone: "good" | "hold" | "quiet"; label: string };
  hasPrev: boolean;
  hasNext: boolean;
  onStep: (delta: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [pageHidden, setPageHidden] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        onStep(1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onStep(-1);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, onStep]);

  /**
   * The overlay covers the grid but did not disable it: Tab walked straight
   * through the scrim into the rows behind, and Space on a Ready tick the
   * reviewer could not see wrote ready_at. The app root goes inert while the
   * overlay is up — the overlay itself is portalled to <body>, outside it.
   */
  useEffect(() => {
    if (!open) return;
    const root = document.getElementById("root");
    if (!root) return;
    root.setAttribute("inert", "");
    return () => root.removeAttribute("inert");
  }, [open]);

  return createPortal(
    <>
      <div
        className={`dgov-scrim${open ? " on" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <section
        className={`dgov${open ? " on" : ""}${pageHidden ? " no-page" : ""}`}
        aria-label="Document"
        aria-hidden={!open}
        inert={!open || undefined}
      >
        <div className="dgov-page">
          <DocumentViewer fileUrl={fileUrl} hidden={pageHidden} />
        </div>

        <div className="dgov-detail">
          <header className="dgov-head">
            {/* Chevrons, not words: three buttons and a vendor name do not fit
                in 468px, and the name is the identifying fact on this header.
                The arrow keys do the same job and the labels say so. */}
            <button
              type="button"
              className="btn btn-small ghost dgov-step"
              onClick={() => onStep(-1)}
              disabled={!hasPrev}
              aria-label="Previous document (left arrow)"
              title="Previous document (left arrow)"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M12.5 4l-5 6 5 6" />
              </svg>
            </button>
            <button
              type="button"
              className="btn btn-small ghost dgov-step"
              onClick={() => onStep(1)}
              disabled={!hasNext}
              aria-label="Next document (right arrow)"
              title="Next document (right arrow)"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M7.5 4l5 6-5 6" />
              </svg>
            </button>
            <span className="dgov-title">
              <span className="dgov-1" title={title}>{title}</span>
              {subtitle ? <span className="dgov-2">{subtitle}</span> : null}
            </span>
            {/* This lives in the detail header, not in the pane it hides:
                inside, hiding the pane took the only way back with it. */}
            <button
              type="button"
              className="btn btn-small ghost dgov-pagetoggle"
              aria-pressed={pageHidden}
              onClick={() => setPageHidden((v) => !v)}
            >
              {pageHidden ? "Show the page" : "Hide the page"}
            </button>
            <button
              type="button"
              className="dgov-x"
              aria-label="Close"
              onClick={onClose}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </button>
          </header>

          <div className="dgov-body">{children}</div>

          {state ? (
            <div className={`dgov-state ${state.tone}`}>{state.label}</div>
          ) : null}
        </div>
      </section>
    </>,
    document.body,
  );
}
