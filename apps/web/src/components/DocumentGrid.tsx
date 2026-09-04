import { useMemo, useState } from "react";
import type { DocumentRow } from "../types";

/**
 * The working grid: one document per row, everything it carries in the row
 * itself. Wide on purpose — it scrolls sideways while the document stays
 * pinned to the left and the ready tick stays pinned to the right, and the
 * grid scrolls rather than the window.
 *
 * Read-only for now. The cells become editable once the overlay has taken
 * over from the old review pane, so that no capability is lost in between.
 *
 * Only columns backed by public.documents_grid are here. The mock also shows
 * GL account, tax code and memo, which need the per-line coding and the
 * dry-run payload; inventing them in the meantime would be worse than
 * leaving them out.
 */
export type Stage = "prepare" | "ready" | "refused" | "posted";

export const STAGES: { key: Stage; label: string }[] = [
  { key: "prepare", label: "Prepare" },
  { key: "ready", label: "Ready to post" },
  { key: "refused", label: "Zoho refused" },
  { key: "posted", label: "Posted" },
];

/**
 * documents.status is unconstrained text recording what the pipeline did.
 * "Zoho refused" is sync_failed, plus approved-with-no-bill-id, which is
 * exactly the state the panel's own "Retry Zoho push" label already detects.
 */
export function stageOf(d: DocumentRow): Stage {
  if (d.status === "synced") return "posted";
  if (d.status === "sync_failed" || (d.status === "approved" && !d.zoho_bill_id))
    return "refused";
  if (d.ready_at) return "ready";
  return "prepare";
}

function money(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-AE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "2-digit",
  });
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function party(d: DocumentRow): string {
  return d.vendor_raw || d.customer_raw || "Not read yet";
}

function initials(name: string): string {
  return (
    name
      .replace(/[^A-Za-z ]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?"
  );
}

function postsAs(d: DocumentRow): string {
  if (d.customer_raw && !d.vendor_raw) return "Sales invoice";
  return d.doc_type === "invoice" ? "Bill" : (d.doc_type ?? "—");
}

interface Props {
  documents: DocumentRow[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  failedJudgmentIds: Set<string>;
  loading: boolean;
}

export function DocumentGrid({
  documents,
  selectedId,
  onOpen,
  failedJudgmentIds,
  loading,
}: Props) {
  const [stage, setStage] = useState<Stage>("prepare");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c: Record<Stage, number> = {
      prepare: 0,
      ready: 0,
      refused: 0,
      posted: 0,
    };
    for (const d of documents) c[stageOf(d)] += 1;
    return c;
  }, [documents]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return documents
      .filter((d) => stageOf(d) === stage)
      .filter((d) => {
        if (!q) return true;
        return [d.vendor_raw, d.customer_raw, d.invoice_number, d.po_number, d.id]
          .some((v) => (v ?? "").toString().toLowerCase().includes(q));
      });
  }, [documents, stage, query]);

  return (
    <section className="dg">
      <nav className="dg-stages" aria-label="Stage">
        {STAGES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`dg-stage${stage === s.key ? " active" : ""}${s.key === "refused" && counts.refused > 0 ? " bad" : ""}`}
            aria-selected={stage === s.key}
            onClick={() => setStage(s.key)}
          >
            {s.label}
            <span className="dg-n">{counts[s.key]}</span>
          </button>
        ))}
      </nav>

      <div className="dg-tools">
        <label className="dg-seek">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="9" cy="9" r="5.5" />
            <path d="M13 13l4 4" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search documents"
            placeholder="Search by vendor, bill number or PO"
          />
        </label>
        <span className="dg-tools-sp" />
      </div>

      <div className="dg-card">
        <div className="dg-wrap">
          <table className="dg-table">
            <thead>
              <tr>
                <th className="dg-k-doc">Document</th>
                <th>Date</th>
                <th className="n">Amount</th>
                <th className="n">VAT</th>
                <th>Posts as</th>
                <th>Purchase order</th>
                <th>Arrived</th>
                <th>Read</th>
                <th>Page</th>
                <th>Checks</th>
                <th>State</th>
                <th>In Zoho</th>
                <th className="dg-k-ready">Ready</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const flagged = failedJudgmentIds.has(d.id);
                const checks =
                  (d.checks_total ?? 0) > 0
                    ? `${d.checks_passed ?? 0} of ${d.checks_total}`
                    : "—";
                return (
                  <tr
                    key={d.id}
                    aria-selected={d.id === selectedId}
                    onClick={() => onOpen(d.id)}
                  >
                    <td className="dg-k-doc">
                      <span className="dg-doc">
                        <span className="dg-mark" aria-hidden="true">
                          {initials(party(d))}
                        </span>
                        <span className="dg-doc-t">
                          <span className="dg-doc-1">{party(d)}</span>
                          <span className="dg-doc-2">
                            {d.invoice_number ?? d.id.slice(0, 8)} ·{" "}
                            {d.doc_type ?? "untyped"}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>{day(d.invoice_date)}</td>
                    <td className="n">
                      {d.currency ? `${d.currency} ` : ""}
                      {money(d.total_amount)}
                    </td>
                    <td className="n">{money(d.tax_amount)}</td>
                    <td>{postsAs(d)}</td>
                    <td>{d.po_number ?? <span className="dg-none">—</span>}</td>
                    <td>
                      <span className="dg-two">
                        <span className="dg-a">{d.source}</span>
                        <span className="dg-b">{when(d.uploaded_at)}</span>
                      </span>
                    </td>
                    <td>
                      {d.confidence == null ? (
                        <span className="dg-none">—</span>
                      ) : (
                        <span className="dg-two">
                          <span className="dg-a">{d.confidence.toFixed(2)}</span>
                          <span className="dg-b">
                            {d.ai_fallback_used ? "second model" : "first read"}
                          </span>
                        </span>
                      )}
                    </td>
                    <td>
                      {d.has_supporting_document ? "Attached" : (
                        <span className="dg-none">None</span>
                      )}
                    </td>
                    <td className={flagged ? "dg-bad" : undefined}>{checks}</td>
                    <td>
                      <span className={`status-pill status-${d.status}`}>
                        {d.status}
                      </span>
                    </td>
                    <td>
                      {d.zoho_bill_id ? (
                        <span className="dg-zid">{d.zoho_bill_id}</span>
                      ) : (
                        <span className="dg-none">—</span>
                      )}
                    </td>
                    <td className="dg-k-ready">
                      <span
                        className={`dg-ready${d.ready_at ? " on" : ""}`}
                        title={
                          d.ready_at
                            ? `Ready${d.ready_by ? ` — ${d.ready_by}` : ""}`
                            : "Not ticked ready"
                        }
                      >
                        <svg viewBox="0 0 20 20" aria-hidden="true">
                          <path d="M5 10.5l3.5 3.5L15 6.5" />
                        </svg>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!loading && rows.length === 0 ? (
            <p className="dg-empty">
              {query
                ? "Nothing here matches that."
                : "Nothing at this stage."}
            </p>
          ) : null}
        </div>

        <div className="dg-pager">
          <span>
            {loading
              ? "Loading…"
              : `${rows.length} of ${documents.length} documents`}
          </span>
        </div>
      </div>
    </section>
  );
}
