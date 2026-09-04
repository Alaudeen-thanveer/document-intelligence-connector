import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

/**
 * One collapsible band of the document detail pane.
 *
 * Whether a band is open is a working habit, not a property of the document:
 * a bookkeeper who never looks at line items wants them shut for every
 * document, not just this one. So the open state is keyed by section and
 * kept in localStorage, and does not reset when the selection changes.
 *
 * The body stays mounted while collapsed. Every field in it is controlled by
 * ReviewPanel's state, so unmounting would not lose an edit — but keeping it
 * mounted means a collapsed section still holds its scroll position and
 * still reports a validation failure when the reviewer tries to post.
 */
const STORAGE_KEY = "dic-panel-sections";

type OpenMap = Record<string, boolean>;

function readOpenMap(): OpenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as OpenMap;
  } catch {
    // A private window, cleared site data, or a browser refusing storage.
    return {};
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readOpenMap(), [id]: open }),
    );
  } catch {
    /* the habit is a convenience; never let it break the panel */
  }
}

/** So one section opening does not leave the others stale in another pane. */
const CHANGED = "dic-panel-section-changed";

export function PanelSection({
  id,
  title,
  note,
  tone,
  defaultOpen = true,
  children,
}: {
  /** Stable key for the remembered open/closed state. */
  id: string;
  title: string;
  /** A short standing fact about the section, e.g. "2 failed". */
  note?: string;
  tone?: "bad" | "warn" | "ok";
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    const stored = readOpenMap()[id];
    return typeof stored === "boolean" ? stored : defaultOpen;
  });

  // Another PanelSection with the same id (a second pane, a second overlay)
  // should not drift out of step with this one.
  const sync = useCallback(() => {
    const stored = readOpenMap()[id];
    setOpen(typeof stored === "boolean" ? stored : defaultOpen);
  }, [id, defaultOpen]);

  useEffect(() => {
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, [sync]);

  function toggle() {
    const next = !open;
    setOpen(next);
    writeOpen(id, next);
    window.dispatchEvent(new Event(CHANGED));
  }

  return (
    <section className={`rp-sec${open ? " open" : ""}`}>
      <h3 className="rp-sec-h">
        <button
          type="button"
          className="rp-sec-top"
          aria-expanded={open}
          onClick={toggle}
        >
          <svg className="rp-sec-caret" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M7.5 5l5 5-5 5" />
          </svg>
          <span className="rp-sec-title">{title}</span>
          {note ? (
            <span className={`rp-sec-note${tone ? ` ${tone}` : ""}`}>
              {note}
            </span>
          ) : null}
        </button>
      </h3>
      <div className="rp-sec-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
