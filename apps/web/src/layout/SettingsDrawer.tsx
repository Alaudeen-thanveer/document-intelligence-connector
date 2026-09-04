import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import { ModeToggle } from "../components/ModeToggle";
import { supabase } from "../lib/supabase";
import { DRAWER_LINKS } from "../nav";

/**
 * The settings drawer, with two ways in:
 *
 *   peek   — the pointer reaches the left edge; it closes itself as soon as
 *            the pointer leaves the drawer.
 *   pinned — the menu button was clicked; it stays until the three dots,
 *            Escape, or the scrim closes it.
 *
 * It carries the two controls that used to live only in the rail's hover
 * popover — the display name and Sign out. Sign out has no other home in
 * the app, so losing it here would leave nobody able to log out.
 *
 * The panel, the scrim and the edge strip are portalled to <body>. They are
 * position:fixed, and the top bar sets backdrop-filter, which makes the bar
 * the containing block for fixed descendants — rendered in place the drawer
 * came out 61px tall rather than full height, and the edge strip 0px, so the
 * hover gesture never fired at all. It still slid in, so it looked like it
 * worked.
 */
type Mode = null | "peek" | "pinned";

export function SettingsDrawer({
  email,
  reviewerName,
  onReviewerName,
}: {
  email: string;
  reviewerName: string;
  onReviewerName: (name: string) => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const open = mode !== null;

  const close = useCallback(() => setMode(null), []);

  // A peek that never reaches the drawer — the pointer only grazed the edge —
  // must not stay open, so watch the pointer and drop it once it is clear.
  useEffect(() => {
    if (mode !== "peek") return;
    function onMove(e: MouseEvent) {
      const r = drawerRef.current?.getBoundingClientRect();
      if (r && e.clientX > r.right + 40) close();
    }
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, [mode, close]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const surfaces = (
    <>
      <div
        className="edge-hot"
        aria-hidden="true"
        onMouseEnter={() => setMode((m) => (m === null ? "peek" : m))}
      />
      <div
        className={`drawer-scrim${mode === "pinned" ? " on" : ""}`}
        onClick={close}
      />
      <aside
        ref={drawerRef}
        className={`drawer${open ? " open" : ""}`}
        aria-label="Settings"
        aria-hidden={!open}
        inert={!open || undefined}
        onMouseLeave={() => setMode((m) => (m === "peek" ? null : m))}
      >
        <div className="drawer-head">
          <h2>Settings</h2>
          {mode === "pinned" ? (
            <button
              type="button"
              className="drawer-dots"
              aria-label="Close settings"
              onClick={close}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="4" r="1.4" />
                <circle cx="10" cy="10" r="1.4" />
                <circle cx="10" cy="16" r="1.4" />
              </svg>
            </button>
          ) : null}
        </div>

        <div className="drawer-body">
          <div className="drawer-group">Reviewer</div>
          <label className="drawer-field">
            Display name
            <input
              value={reviewerName}
              onChange={(e) => onReviewerName(e.target.value)}
            />
          </label>
          <p className="drawer-note">{email}</p>

          <div className="drawer-group">Set up</div>
          {DRAWER_LINKS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `drawer-link${isActive ? " active" : ""}`
              }
              onClick={close}
            >
              {item.label}
            </NavLink>
          ))}

          <div className="drawer-group">Appearance</div>
          <div className="drawer-row">
            <ModeToggle />
          </div>
        </div>

        <div className="drawer-foot">
          <button
            type="button"
            className="btn ghost btn-small"
            onClick={() => void supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </aside>
    </>
  );

  return (
    <>
      <button
        type="button"
        className={`appbar-icon${mode === "pinned" ? " on" : ""}`}
        aria-label="Settings"
        aria-expanded={mode === "pinned"}
        onClick={() => setMode((m) => (m === "pinned" ? null : "pinned"))}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3 6h14M3 10h14M3 14h14" />
        </svg>
      </button>
      {createPortal(surfaces, document.body)}
    </>
  );
}
