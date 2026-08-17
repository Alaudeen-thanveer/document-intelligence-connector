import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";

export function SignInPage() {
  const [email, setEmail] = useState("ala@local.test");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (signError) setError(signError.message);
  }

  return (
    <div className="app-shell">
      <div className="atmosphere" aria-hidden="true" />
      <div className="signin-wrap">
        <p className="brand">Document Intelligence Connector</p>
        <h1>Sign in</h1>
        <p className="muted">
          Use the local Supabase user (Studio → Authentication). Approve
          needs this session so Zoho sync is scoped to your company.
        </p>
        <form className="signin-card" onSubmit={(e) => void onSubmit(e)}>
          <label className="reviewer-field">
            Email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="reviewer-field">
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
