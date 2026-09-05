import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { shortDate, shortStamp } from "../lib/dates";
import type { DocumentRow } from "../types";

/**
 * The working grid: one document per row, everything it carries in the row
 * itself. Wide on purpose — it scrolls sideways while the document stays
 * pinned to the left and the ready tick stays pinned to the right, and the
 * grid scrolls rather than the window.
 *
 * Four columns are editable in place. An edit here SAVES THAT FIELD AND
 * NOTHING ELSE: it never touches documents.status, which belongs to the
 * pipeline, and it never runs a check. Correcting what was read off the page
 * is not the same act as deciding the document is right.
 *
 * The ready tick is the decision, and it is the reviewer's alone: it writes
 * documents.ready_at and ready_by, and nothing else.
 *
 * Only columns backed by public.documents_grid are here. The mock also shows
 * GL account, tax code and memo, which need the per-line coding and the
 * dry-run payload; inventing them in the meantime would be worse than
 * leaving them out.
 */
export type Stage = "prepare" | "ready" | "refused" | "posted";

/** The fields a cell edit may write. Deliberately a closed set. */
export type EditableField =
  | "invoice_date"
  | "total_amount"
  | "tax_amount"
  | "po_number";

const FIELD_LABEL: Record<EditableField, string> = {
  invoice_date: "date",
  total_amount: "amount",
  tax_amount: "VAT",
  po_number: "purchase order",
};

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

/** What goes into the editor when a cell is opened. */
function draftOf(d: DocumentRow, field: EditableField): string {
  const v = d[field];
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * What gets written. Blank clears the field; a number that is not a number is
 * refused rather than silently stored as null, because "" and "not a number"
 * mean very different things about a document.
 */
function parseDraft(
  field: EditableField,
  raw: string,
): { ok: true; value: string | number | null } | { ok: false; why: string } {
  const s = raw.trim();
  if (s === "") return { ok: true, value: null };

  if (field === "total_amount" || field === "tax_amount") {
    const n = Number(s.replace(/,/g, ""));
    if (!Number.isFinite(n)) return { ok: false, why: "That is not a number." };
    if (n < 0) return { ok: false, why: "That cannot be negative." };
    return { ok: true, value: n };
  }

  if (field === "invoice_date") {
    // <input type="date"> already gives YYYY-MM-DD; guard a typed value.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return { ok: false, why: "Use a date like 2026-08-19." };
    }
    const t = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(t.getTime())) return { ok: false, why: "That is not a date." };
    return { ok: true, value: s };
  }

  return { ok: true, value: s };
}

interface EditState {
  id: string;
  field: EditableField;
  /**
   * What the cell held when the editor opened. Two things depend on it:
   * "did the reviewer change anything" must be asked against this, not
   * against the row's value now — the row can change underneath — and if the
   * row HAS changed underneath, the save must be refused rather than putting
   * a stale number back.
   */
  original: string;
  draft: string;
  saving: boolean;
  error: string | null;
  /** Identifies this editor, so a save that lands late cannot close a later one. */
  token: number;
}

interface Props {
  documents: DocumentRow[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  /** The filtered, sorted queue, so Prev/Next steps what is on screen. */
  onVisible: (ids: string[]) => void;
  /** Writes one field of the current extraction. Rejects with a message. */
  onSaveField: (
    row: DocumentRow,
    field: EditableField,
    value: string | number | null,
  ) => Promise<void>;
  /** Sets or clears the ready decision. Never touches status. */
  onToggleReady: (row: DocumentRow) => Promise<void>;
  failedJudgmentIds: Set<string>;
  loading: boolean;
  /** Sits at the right of the stage row — the page's own controls. */
  actions?: ReactNode;
  /** Something the page wants said in the status line, e.g. an upload. */
  notice?: { text: string; tone: "ok" | "bad" } | null;
}

export function DocumentGrid({
  documents,
  selectedId,
  onOpen,
  onVisible,
  onSaveField,
  onToggleReady,
  failedJudgmentIds,
  loading,
  actions,
  notice,
}: Props) {
  const [stage, setStage] = useState<Stage>("prepare");
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<EditState | null>(null);
  const editToken = useRef(0);
  const [readyBusy, setReadyBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<number | null>(null);

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

  // Compared by value, not identity: rows is a fresh array every render, and
  // the parent re-renders on every keystroke in the panel.
  const visibleKey = rows.map((r) => r.id).join(",");
  useEffect(() => {
    onVisible(visibleKey ? visibleKey.split(",") : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  useEffect(() => {
    return () => {
      if (noteTimer.current) window.clearTimeout(noteTimer.current);
    };
  }, []);

  // A background write can change a row's stage while it is being edited —
  // the pipeline finishing an extraction, a colleague approving it. The row
  // then leaves this list, the editor unmounts, and because unmounting fires
  // no blur the draft goes with it. Say so rather than letting it vanish.
  const editId = edit?.id ?? null;
  useEffect(() => {
    if (!editId) return;
    if (visibleKey.split(",").includes(editId)) return;
    setEdit(null);
    say("That row left this list while you were editing it — nothing was saved.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, visibleKey]);

  function say(message: string) {
    setNote(message);
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 4000);
  }

  function openEditor(row: DocumentRow, field: EditableField) {
    if (!row.extracted_fields_id) return;
    const opened = draftOf(row, field);
    setEdit({
      id: row.id,
      field,
      original: opened,
      draft: opened,
      saving: false,
      error: null,
      token: ++editToken.current,
    });
  }

  async function commit(row: DocumentRow) {
    if (!edit || edit.saving) return;
    const { field, draft, original, token } = edit;

    /** Only touch the editor if it is still the one this save belongs to. */
    const ifStillMine = (next: EditState | null) =>
      setEdit((cur) => (cur && cur.token !== token ? cur : next));

    if (draft === original) {
      ifStillMine(null);
      return;
    }

    // The row moved under the editor — a re-extraction, or a colleague in
    // another tab. Writing the draft now would put the older value back, and
    // merely opening a cell and clicking away would be enough to do it.
    if (draftOf(row, field) !== original) {
      setEdit({
        ...edit,
        error: "This changed elsewhere while you had it open. Close and look again.",
      });
      return;
    }

    const parsed = parseDraft(field, draft);
    if (!parsed.ok) {
      setEdit({ ...edit, error: parsed.why });
      return;
    }

    setEdit({ ...edit, saving: true, error: null });
    try {
      await onSaveField(row, field, parsed.value);
      ifStillMine(null);
      say(`Saved the ${FIELD_LABEL[field]}.`);
    } catch (e) {
      const why = e instanceof Error ? e.message : "Could not save that.";
      ifStillMine({ ...edit, saving: false, error: why });
    }
  }

  async function toggleReady(row: DocumentRow) {
    if (readyBusy) return;
    setReadyBusy(row.id);
    const wasReady = Boolean(row.ready_at);
    try {
      await onToggleReady(row);
      say(
        wasReady
          ? "Ready removed — back to Prepare."
          : stage === "prepare"
            ? "Ticked ready — the row moved to Ready to post."
            : "Ticked ready.",
      );
    } catch (e) {
      say(e instanceof Error ? e.message : "Could not change that.");
    } finally {
      setReadyBusy(null);
    }
  }

  /** One editable cell: a button until it is opened, an input after. */
  function cell(
    row: DocumentRow,
    field: EditableField,
    shown: string,
    extraClass = "",
  ) {
    const open = edit?.id === row.id && edit.field === field;
    const editable = Boolean(row.extracted_fields_id);

    if (!open) {
      return (
        <td className={extraClass} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={`dg-cell${editable ? "" : " locked"}`}
            disabled={!editable}
            title={
              editable
                ? `Edit the ${FIELD_LABEL[field]}`
                : "Nothing has been read off this document yet"
            }
            aria-label={`${FIELD_LABEL[field]}: ${shown}. Click to edit.`}
            onClick={() => openEditor(row, field)}
          >
            {shown}
          </button>
        </td>
      );
    }

    const isDate = field === "invoice_date";
    const isNumber = field === "total_amount" || field === "tax_amount";

    return (
      <td
        className={`${extraClass} dg-editing`.trim()}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          className={`dg-input${edit.error ? " bad" : ""}`}
          type={isDate ? "date" : "text"}
          {...(isDate ? {} : { size: 1 })}
          inputMode={isNumber ? "decimal" : undefined}
          value={edit.draft}
          autoFocus
          disabled={edit.saving}
          aria-label={`Edit the ${FIELD_LABEL[field]}`}
          aria-invalid={edit.error ? true : undefined}
          onChange={(e) => setEdit({ ...edit, draft: e.target.value, error: null })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit(row);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setEdit(null);
            }
          }}
          onBlur={() => {
            // A failed save keeps the editor open so the reason stays on
            // screen; blurring away from it would throw the reason away.
            if (edit.error) return;
            void commit(row);
          }}
        />
        {edit.error ? <span className="dg-cell-bad">{edit.error}</span> : null}
      </td>
    );
  }

  return (
    <section className="dg">
      <nav className="dg-stages" aria-label="Stage">
        {STAGES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`dg-stage${stage === s.key ? " active" : ""}${s.key === "refused" && counts.refused > 0 ? " bad" : ""}`}
            aria-selected={stage === s.key}
            onClick={() => {
              setEdit(null);
              setStage(s.key);
            }}
          >
            {s.label}
            <span className="dg-n">{counts[s.key]}</span>
          </button>
        ))}
        <span className="dg-stages-sp" />
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
        {actions}
      </nav>

      <div className="dg-card">
        <div className="dg-wrap">
          <table className="dg-table">
            <thead>
              <tr>
                <th className="dg-k-doc">Document</th>
                <th className="dg-k-date">Date</th>
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
                      {/* The row's onClick is for the mouse; this is the only
                          way a keyboard reaches the document. */}
                      <button
                        type="button"
                        className="dg-doc"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(d.id);
                        }}
                      >
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
                      </button>
                    </td>
                    {cell(d, "invoice_date", shortDate(d.invoice_date), "dg-k-date")}
                    {cell(
                      d,
                      "total_amount",
                      `${d.currency ? `${d.currency} ` : ""}${money(d.total_amount)}`,
                      "n",
                    )}
                    {cell(d, "tax_amount", money(d.tax_amount), "n")}
                    <td>{postsAs(d)}</td>
                    {cell(d, "po_number", d.po_number ?? "—")}
                    <td>
                      <span className="dg-two">
                        <span className="dg-a">{d.source}</span>
                        <span className="dg-b">{shortStamp(d.uploaded_at)}</span>
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
                        {/* The column stores what the pipeline did as
                            snake_case text; the underscores are storage, not
                            language. The capital comes from the stylesheet,
                            so every pill in the app reads the same way. */}
                        {d.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td>
                      {d.zoho_bill_id ? (
                        <span className="dg-zid">{d.zoho_bill_id}</span>
                      ) : (
                        <span className="dg-none">—</span>
                      )}
                    </td>
                    <td
                      className="dg-k-ready"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className={`dg-ready${d.ready_at ? " on" : ""}`}
                        aria-pressed={Boolean(d.ready_at)}
                        disabled={readyBusy === d.id}
                        aria-label={
                          d.ready_at
                            ? `Ready${d.ready_by ? `, ticked by ${d.ready_by}` : ""}. Click to take it back.`
                            : "Not ready. Click to tick it ready."
                        }
                        title={
                          d.ready_at
                            ? `Ready${d.ready_by ? ` — ${d.ready_by}` : ""}`
                            : "Not ticked ready"
                        }
                        onClick={() => void toggleReady(d)}
                      >
                        <svg viewBox="0 0 20 20" aria-hidden="true">
                          <path d="M5 10.5l3.5 3.5L15 6.5" />
                        </svg>
                      </button>
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
          <span
            className={`dg-say${!note && notice?.tone === "bad" ? " bad" : ""}`}
            role="status"
            aria-live="polite"
          >
            {note ?? notice?.text ?? ""}
          </span>
        </div>
      </div>
    </section>
  );
}
