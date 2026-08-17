import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { ApiUsagePage } from "./components/ApiUsagePage";
import { ConnectionsPage } from "./components/ConnectionsPage";
import { MonthEndPage } from "./components/MonthEndPage";
import { SignInPage } from "./components/SignInPage";
import { AppLayout } from "./layout/AppLayout";
import { supabase } from "./lib/supabase";
import { DocumentsPage } from "./pages/DocumentsPage";
import { RulesPage } from "./pages/RulesPage";

const LEGACY_HASH: Record<string, string> = {
  connections: "/connections",
  "month-end": "/month-end",
  "api-usage": "/api-usage",
  rules: "/rules",
};

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="app-shell">
        <div className="atmosphere" aria-hidden="true" />
        <p className="muted">Checking session…</p>
      </div>
    );
  }

  if (!session) return <SignInPage />;

  return (
    <>
      <LegacyHashRedirect />
      <Routes>
        <Route element={<AppLayout session={session} />}>
          <Route path="/" element={<DocumentsPage />} />
          <Route path="/month-end" element={<MonthEndPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/api-usage" element={<ApiUsagePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}

/** Old hash tabs (#connections) → real paths (/connections). */
function LegacyHashRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const dest = LEGACY_HASH[raw];
    if (dest) navigate(dest, { replace: true });
  }, [navigate]);
  return null;
}
