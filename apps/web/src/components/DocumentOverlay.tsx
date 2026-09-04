import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * The overlay a row opens into. This slice builds the shell only, and mounts
 * today's ReviewPanel inside it completely untouched — which is the whole
 * point of the sequencing: the grid can land without any chance of losing
 * something the review pane could do. The document pane, zoom and Prev/Next
 * come next; the panel is split into sections after that.
 *
 * Portalled to <body>, like the settings drawer, so no ancestor's
 * backdrop-filter or transform can become the containing block for its
 * position:fixed surfaces.
 */
export function DocumentOverlay({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return createPortal(
    <>
      <div
        className={`dgov-scrim${open ? " on" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <section
        className={`dgov${open ? " on" : ""}`}
        aria-label="Document"
        aria-hidden={!open}
        inert={!open || undefined}
      >
        <header className="dgov-head">
          <span className="dgov-title">
            <span className="dgov-1">{title}</span>
            {subtitle ? <span className="dgov-2">{subtitle}</span> : null}
          </span>
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
      </section>
    </>,
    document.body,
  );
}
