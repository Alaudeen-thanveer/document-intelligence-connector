import { NavLink, Outlet } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { useMonthEndAttention } from "../hooks/useMonthEndAttention";
import { TABS } from "../nav";
import { setActor } from "../lib/functions";
import { SettingsDrawer } from "./SettingsDrawer";

export interface AppOutletContext {
  reviewerName: string;
  session: Session;
}

export function AppLayout({ session }: { session: Session }) {
  const email = session.user.email ?? "reviewer";
  const [reviewerName, setReviewerName] = useState(
    email.split("@")[0] || "reviewer",
  );
  const monthEndAttention = useMonthEndAttention();
  const initials = reviewerName.trim().slice(0, 2).toUpperCase() || "R";

  useEffect(() => {
    setActor(reviewerName);
  }, [reviewerName]);

  return (
    <div className="app-frame">
      <header className="appbar">
        <div className="appbar-lead">
          <SettingsDrawer
            email={email}
            reviewerName={reviewerName}
            onReviewerName={setReviewerName}
          />
          <span className="appbar-brand">
            <i className="appbar-dot" aria-hidden="true" />
            <span className="appbar-name">Verity</span>
          </span>
        </div>

        <nav className="appbar-seg" aria-label="Sections">
          {TABS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              // Without this the Documents link matches every route.
              end={item.path === "/"}
              className={({ isActive }) => `appbar-tab${isActive ? " active" : ""}`}
            >
              {item.label}
              {item.path === "/month-end" && monthEndAttention ? (
                <span className="appbar-tabdot" aria-label="needs attention" />
              ) : null}
            </NavLink>
          ))}
        </nav>

        <div className="appbar-who">
          <span className="appbar-whoname">
            <span className="appbar-who1">{reviewerName}</span>
            <span className="appbar-who2">{email}</span>
          </span>
          <span className="appbar-av" aria-hidden="true">
            {initials}
          </span>
        </div>
      </header>

      <div className="app-content">
        <Outlet context={{ reviewerName, session } satisfies AppOutletContext} />
      </div>
    </div>
  );
}
