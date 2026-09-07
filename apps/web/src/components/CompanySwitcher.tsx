import { useState } from "react";
import { useCompany } from "../hooks/useCompany";

/**
 * Which company this person is working in, in the header.
 *
 * One company: a label — there is nothing to choose. Several: a picker,
 * with "Choose a company…" until they have. Everything on every page is
 * scoped to the chosen company by the database, so choosing reloads the app.
 */
export function CompanySwitcher() {
  const { companies, current, loading, error, choose } = useCompany();
  const [failed, setFailed] = useState<string | null>(null);

  if (loading) return null;
  if (error) {
    return (
      <span className="appbar-company appbar-company-muted" title={error}>
        Company unavailable
      </span>
    );
  }
  if (companies.length === 0) {
    return (
      <span className="appbar-company appbar-company-muted" title="This account belongs to no company">
        No company
      </span>
    );
  }
  if (companies.length === 1) {
    return (
      <span className="appbar-company" title="The company you work in">
        {companies[0].company_name}
      </span>
    );
  }

  return (
    <span className="appbar-company">
      <select
        aria-label="Company you are working in"
        title={failed ?? "Company you are working in"}
        value={current?.company_id ?? ""}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) return;
          setFailed(null);
          choose(id).catch((err: unknown) => {
            setFailed(err instanceof Error ? err.message : String(err));
          });
        }}
      >
        {!current && <option value="">Choose a company…</option>}
        {companies.map((c) => (
          <option key={c.company_id} value={c.company_id}>
            {c.company_name}
          </option>
        ))}
      </select>
      {failed && (
        <span className="appbar-company-error" role="alert">
          {failed}
        </span>
      )}
    </span>
  );
}
