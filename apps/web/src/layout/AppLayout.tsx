import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { useMonthEndAttention } from "../hooks/useMonthEndAttention";
import { setActor } from "../lib/functions";
import { supabase } from "../lib/supabase";
import { useTheme } from "../theme/ThemeProvider";

const SECTIONS: Record<string, string> = {
  "/": "Documents",
  "/month-end": "Month-end",
  "/connections": "Connections",
  "/rules": "Rules",
  "/api-usage": "API usage",
};

export interface AppOutletContext {
  reviewerName: string;
  session: Session;
}

export function AppLayout({ session }: { session: Session }) {
  const email = session.user.email ?? "reviewer";
  const [reviewerName, setReviewerName] = useState(
    email.split("@")[0] || "reviewer",
  );
  const location = useLocation();
  const monthEndAttention = useMonthEndAttention();
  const section = SECTIONS[location.pathname] ?? "Documents";
  const initials = reviewerName.trim().slice(0, 1).toUpperCase() || "R";

  useEffect(() => {
    setActor(reviewerName);
  }, [reviewerName]);

  return (
    <div className="app-frame">
      <aside className="rail" aria-label="App sections">
        <div className="rail-mark" aria-hidden="true">
          DI
        </div>

        <div className="rail-group">
          <RailLink to="/" label="Documents" icon="▤" />
          <RailLink
            to="/month-end"
            label={
              monthEndAttention
                ? "Month-end · needs attention"
                : "Month-end"
            }
            icon="◔"
            dot={monthEndAttention}
          />
        </div>

        <div className="rail-divider" />

        <div className="rail-group">
          <RailLink to="/connections" label="Connections" icon="⇄" />
          <RailLink to="/rules" label="Rules" icon="§" />
          <RailLink to="/api-usage" label="API usage" icon="▦" />
        </div>

        <div className="rail-spacer" />

        <div className="rail-identity" tabIndex={0}>
          {initials}
          <div className="rail-tip rail-tip-identity">
            <div className="rail-tip-lbl">Reviewer</div>
            <div className="rail-tip-val">{reviewerName}</div>
            <div className="rail-tip-lbl">{email}</div>
            <label className="rail-name-field">
              Display name
              <input
                value={reviewerName}
                onChange={(e) => setReviewerName(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn ghost btn-small"
              onClick={() => void supabase.auth.signOut()}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="app-content">
        <header className="content-head-bar">
          <span className="crumb">
            Document Intelligence Connector / <b>{section}</b>
          </span>
          <ModeToggle />
        </header>
        <Outlet context={{ reviewerName, session } satisfies AppOutletContext} />
      </div>
    </div>
  );
}

function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "ink";
  return (
    <button
      type="button"
      className={`mode-toggle${isDark ? " dark" : ""}`}
      aria-pressed={isDark}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "chalk" : "ink")}
    >
      <span className="mode-toggle-switch" aria-hidden="true" />
      <span>{isDark ? "Dark" : "Light"}</span>
    </button>
  );
}

function RailLink({
  to,
  label,
  icon,
  dot,
}: {
  to: string;
  label: string;
  icon: string;
  dot?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) => `rail-btn${isActive ? " active" : ""}`}
      aria-label={label}
    >
      <span aria-hidden="true">{icon}</span>
      {dot ? <span className="rail-dot" /> : null}
      <span className="rail-tip">{label}</span>
    </NavLink>
  );
}
