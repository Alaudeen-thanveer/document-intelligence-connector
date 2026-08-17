import { useCallback, useEffect, useMemo, useState } from "react";
import { callEdgeFunction, newActionId } from "../lib/functions";
import { supabase } from "../lib/supabase";

/**
 * Bank — a statement comes in (CSV/TSV upload, PDF, or pasted text; the
 * mailbox will call the same entry point), each line gets a SUGGESTION
 * where the app has grounds for one, and the reviewer decides line by
 * line. Nothing reaches Zoho Books until a line is confirmed AND pushed.
 * A line with nothing suggestible is just left open — no guessing.
 */

type Side = "debit" | "credit";
type TxnKind = "customer_payment" | "vendor_payment" | "expense" | "deposit" | "transfer" | "other";

interface Suggestion {
  txn_kind: TxnKind;
  party_kind: "vendor" | "customer" | null;
  party_zoho_id: string | null;
  party_name: string | null;
  account_id: string | null;
  account_name: string | null;
  doc_kind: "invoice" | "bill" | null;
  doc_zoho_id: string | null;
  doc_number: string | null;
  doc_balance: number | null;
  confidence: number;
  source: "open_document" | "learned" | "accepted_rule" | "party_name";
  reason: string;
}

interface Line {
  id: string;
  line_no: number;
  txn_date: string;
  description: string;
  reference: string | null;
  side: Side;
  amount: number;
  balance: number | null;
  suggestion: Suggestion | null;
  status: "open" | "confirmed" | "posted" | "skipped" | "failed";
  chosen_txn_kind: TxnKind | null;
  chosen_party_kind: "vendor" | "customer" | null;
  chosen_party_zoho_id: string | null;
  chosen_party_name: string | null;
  chosen_account_id: string | null;
  chosen_account_name: string | null;
  chosen_doc_kind: "invoice" | "bill" | null;
  chosen_doc_zoho_id: string | null;
  chosen_doc_number: string | null;
  decision: string | null;
  zoho_txn_id: string | null;
  error: string | null;
}

interface Statement {
  id: string;
  bank_account_zoho_id: string;
  bank_account_name: string | null;
  source: string;
  original_name: string | null;
  period_start: string | null;
  period_end: string | null;
  line_count: number;
  skipped_rows: Array<{ row: number; reason: string; text: string }>;
  created_at: string;
  created_by: string | null;
}

interface Entity { zoho_id: string; name: string; kind: string }

const KIND_LABEL: Record<TxnKind, string> = {
  customer_payment: "Customer receipt",
  vendor_payment: "Vendor payment",
  expense: "Expense",
  deposit: "Deposit / other income",
  transfer: "Transfer",
  other: "Other",
};
const KINDS_IN: TxnKind[] = ["customer_payment", "deposit", "transfer", "other"];
const KINDS_OUT: TxnKind[] = ["vendor_payment", "expense", "transfer", "other"];
const SOURCE_LABEL: Record<Suggestion["source"], string> = {
  open_document: "matches an open document",
  accepted_rule: "your rule",
  learned: "learned from history",
  party_name: "name only",
};

function money(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Local edit state for one line — starts from the suggestion, if any. */
interface Draft {
  txn_kind: TxnKind | "";
  party_kind: "vendor" | "customer" | null;
  party_zoho_id: string;
  account_id: string;
  doc_zoho_id: string;
}
function draftFrom(l: Line): Draft {
  const s = l.suggestion;
  if (l.status !== "open" && l.chosen_txn_kind) {
    return { txn_kind: l.chosen_txn_kind, party_kind: l.chosen_party_kind, party_zoho_id: l.chosen_party_zoho_id ?? "", account_id: l.chosen_account_id ?? "", doc_zoho_id: l.chosen_doc_zoho_id ?? "" };
  }
  return {
    txn_kind: s?.txn_kind ?? "",
    party_kind: s?.party_kind ?? null,
    party_zoho_id: s?.party_zoho_id ?? "",
    account_id: s?.account_id ?? "",
    doc_zoho_id: s?.doc_zoho_id ?? "",
  };
}
/** Which party list a kind uses (expense: vendor is optional — bank charges have none). */
function partyKindFor(kind: TxnKind | ""): "vendor" | "customer" | null {
  if (kind === "customer_payment" || kind === "deposit") return "customer";
  if (kind === "vendor_payment" || kind === "expense") return "vendor";
  return null;
}
/** Receipts and payments must name who; expenses and deposits need not. */
function partyRequired(kind: TxnKind | ""): boolean {
  return kind === "customer_payment" || kind === "vendor_payment";
}
function needsAccount(kind: TxnKind | ""): boolean {
  return kind === "expense" || kind === "deposit" || kind === "transfer";
}

export function BankPage({ reviewerName }: { reviewerName: string }) {
  const [bankAccounts, setBankAccounts] = useState<Entity[]>([]);
  const [vendors, setVendors] = useState<Entity[]>([]);
  const [customers, setCustomers] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<Entity[]>([]);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [current, setCurrent] = useState<Statement | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [bankAccountId, setBankAccountId] = useState("");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPosted, setShowPosted] = useState(true);

  // ---- masters + statement list -------------------------------------
  const loadMasters = useCallback(async () => {
    const { data } = await supabase.from("zoho_entities").select("kind, zoho_id, name").in("kind", ["bank_account", "vendor", "customer", "account"]).order("name");
    const rows = (data ?? []) as Entity[];
    setBankAccounts(rows.filter((r) => r.kind === "bank_account"));
    setVendors(rows.filter((r) => r.kind === "vendor"));
    setCustomers(rows.filter((r) => r.kind === "customer"));
    setAccounts(rows.filter((r) => r.kind === "account"));
  }, []);
  const loadStatements = useCallback(async () => {
    const { data } = await supabase.from("bank_statements").select("*").order("created_at", { ascending: false }).limit(30);
    setStatements((data ?? []) as Statement[]);
  }, []);
  const loadLines = useCallback(async (statementId: string) => {
    const { data } = await supabase.from("bank_statement_lines").select("*").eq("statement_id", statementId).order("line_no");
    const ls = (data ?? []) as Line[];
    setLines(ls);
    setDrafts((prev) => {
      const next: Record<string, Draft> = {};
      for (const l of ls) next[l.id] = prev[l.id] && l.status === "open" ? prev[l.id] : draftFrom(l);
      return next;
    });
  }, []);

  useEffect(() => { void loadMasters(); void loadStatements(); }, [loadMasters, loadStatements]);
  useEffect(() => { if (bankAccounts.length && !bankAccountId) setBankAccountId(bankAccounts[0].zoho_id); }, [bankAccounts, bankAccountId]);
  useEffect(() => { if (current) void loadLines(current.id); }, [current, loadLines]);

  // ---- ingest --------------------------------------------------------
  async function ingest(payload: Record<string, unknown>) {
    if (!bankAccountId) { setError("Pick which bank account this statement is for."); return; }
    setBusy("ingest"); setError(null); setNotice(null);
    const res = await callEdgeFunction("bank-statement", { action: "ingest", bank_account_zoho_id: bankAccountId, ...payload });
    setBusy(null);
    if (!res.ok) { setError(String(res.body.error ?? `Failed (${res.status})`)); return; }
    const sug = res.body.suggestions as { suggested: number; open: number; open_docs: number } | undefined;
    setNotice(`${res.body.line_count} lines read · ${sug?.suggested ?? 0} with a suggestion · ${sug?.open ?? 0} left open for you · ${(res.body.skipped as unknown[])?.length ?? 0} rows skipped`);
    await loadStatements();
    const { data } = await supabase.from("bank_statements").select("*").eq("id", String(res.body.statement_id)).single();
    if (data) setCurrent(data as Statement);
    setPasted("");
  }
  async function onFile(file: File | null) {
    if (!file) return;
    const isPdf = /pdf|image/i.test(file.type);
    if (!isPdf) {
      const text = await file.text();
      await ingest({ source: "upload_csv", text, original_name: file.name });
      return;
    }
    setBusy("upload");
    const path = `statements/${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    const { error: upErr } = await supabase.storage.from("invoices").upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) { setBusy(null); setError(upErr.message); return; }
    const { data } = supabase.storage.from("invoices").getPublicUrl(path);
    await ingest({ source: "upload_pdf", file_url: data.publicUrl, original_name: file.name });
  }

  // ---- decide --------------------------------------------------------
  function setDraft(id: string, patch: Partial<Draft>) {
    setDrafts((d) => {
      const cur = d[id] ?? { txn_kind: "", party_kind: null, party_zoho_id: "", account_id: "", doc_zoho_id: "" };
      const next = { ...cur, ...patch };
      if (patch.txn_kind !== undefined) {
        next.party_kind = partyKindFor(patch.txn_kind);
        if (next.party_kind !== cur.party_kind) next.party_zoho_id = "";
        if (!needsAccount(patch.txn_kind)) next.account_id = "";
        if (patch.txn_kind !== "customer_payment" && patch.txn_kind !== "vendor_payment") next.doc_zoho_id = "";
      }
      return { ...d, [id]: next };
    });
  }
  function nameOf(list: Entity[], id: string): string | null {
    return list.find((e) => e.zoho_id === id)?.name ?? null;
  }
  async function confirm(l: Line) {
    const d = drafts[l.id];
    if (!d?.txn_kind) { setError(`Line ${l.line_no}: choose what this is first.`); return; }
    if (partyRequired(d.txn_kind) && !d.party_zoho_id) { setError(`Line ${l.line_no}: pick the ${partyKindFor(d.txn_kind)}.`); return; }
    if (needsAccount(d.txn_kind) && !d.account_id) { setError(`Line ${l.line_no}: pick the account.`); return; }
    setBusy(l.id); setError(null);
    const s = l.suggestion;
    const docKind = d.txn_kind === "customer_payment" ? "invoice" : d.txn_kind === "vendor_payment" ? "bill" : null;
    const res = await callEdgeFunction("bank-statement", {
      action: "confirm", line_id: l.id, chosen_txn_kind: d.txn_kind,
      chosen_party_kind: d.party_kind, chosen_party_zoho_id: d.party_zoho_id || null,
      chosen_party_name: d.party_zoho_id ? (nameOf(d.party_kind === "customer" ? customers : vendors, d.party_zoho_id) ?? s?.party_name ?? null) : null,
      chosen_account_id: d.account_id || null, chosen_account_name: d.account_id ? nameOf(accounts, d.account_id) : null,
      chosen_doc_kind: d.doc_zoho_id ? docKind : null, chosen_doc_zoho_id: d.doc_zoho_id || null,
      chosen_doc_number: d.doc_zoho_id && s?.doc_zoho_id === d.doc_zoho_id ? s.doc_number : null,
    });
    setBusy(null);
    if (!res.ok) { setError(`Line ${l.line_no}: ${String(res.body.error ?? "could not confirm")}`); return; }
    if (current) await loadLines(current.id);
  }
  async function skip(l: Line) {
    setBusy(l.id);
    await callEdgeFunction("bank-statement", { action: "confirm", line_id: l.id, skip: true });
    setBusy(null);
    if (current) await loadLines(current.id);
  }
  async function reopen(l: Line) {
    await supabase.from("bank_statement_lines").update({ status: "open", decision: null, error: null }).eq("id", l.id);
    if (current) await loadLines(current.id);
  }
  /** Confirm every open line whose suggestion is complete, in one action. */
  async function acceptAllSuggested() {
    const targets = lines.filter((l) => l.status === "open" && l.suggestion && draftComplete(drafts[l.id]));
    if (!targets.length) return;
    setBusy("bulk"); setError(null);
    const actionId = newActionId();
    let ok = 0;
    for (const l of targets) {
      const d = drafts[l.id]; const s = l.suggestion!;
      const res = await callEdgeFunction("bank-statement", {
        action: "confirm", line_id: l.id, chosen_txn_kind: d.txn_kind,
        chosen_party_kind: d.party_kind, chosen_party_zoho_id: d.party_zoho_id || null, chosen_party_name: s.party_name,
        chosen_account_id: d.account_id || null, chosen_account_name: s.account_name,
        chosen_doc_kind: d.doc_zoho_id ? s.doc_kind : null, chosen_doc_zoho_id: d.doc_zoho_id || null, chosen_doc_number: d.doc_zoho_id ? s.doc_number : null,
      }, { actionId });
      if (res.ok) ok++;
    }
    setBusy(null);
    setNotice(`${ok} of ${targets.length} suggested lines confirmed. Nothing has gone to Zoho yet — press “Post confirmed to Zoho”.`);
    if (current) await loadLines(current.id);
  }
  function draftComplete(d: Draft | undefined): boolean {
    if (!d?.txn_kind) return false;
    if (partyRequired(d.txn_kind) && !d.party_zoho_id) return false;
    if (needsAccount(d.txn_kind) && !d.account_id) return false;
    return true;
  }

  // ---- push ----------------------------------------------------------
  async function push() {
    if (!current) return;
    setBusy("push"); setError(null);
    const res = await callEdgeFunction("bank-statement", { action: "push", statement_id: current.id });
    setBusy(null);
    const b = res.body as { pushed?: number; failed?: number; error?: string };
    if (b.error && !b.pushed) setError(String(b.error));
    else setNotice(`Posted ${b.pushed ?? 0} to Zoho Books${b.failed ? ` · ${b.failed} failed — see the line for why` : ""}.`);
    await loadLines(current.id);
  }

  // ---- derived -------------------------------------------------------
  const counts = useMemo(() => ({
    open: lines.filter((l) => l.status === "open").length,
    suggested: lines.filter((l) => l.status === "open" && l.suggestion).length,
    confirmed: lines.filter((l) => l.status === "confirmed").length,
    posted: lines.filter((l) => l.status === "posted").length,
    failed: lines.filter((l) => l.status === "failed").length,
    skipped: lines.filter((l) => l.status === "skipped").length,
  }), [lines]);
  const visible = showPosted ? lines : lines.filter((l) => l.status !== "posted" && l.status !== "skipped");

  return (
    <main className="connections-layout">
      <div className="pane-heading">
        <h2>Bank</h2>
        <span className="muted">{reviewerName ? `Deciding as ${reviewerName}` : ""}</span>
      </div>
      <p className="muted connections-intro">
        Bring in a statement, and each line gets a suggestion where the app has grounds for one — an open invoice or bill it matches, or how lines like it were booked before. You decide every line. Nothing reaches Zoho Books until you confirm and post.
      </p>

      {/* ------------------------------------------------- intake */}
      <section className="panel connection-card">
        <header className="panel-header">
          <div>
            <p className="eyebrow">New statement</p>
            <h2>Which bank account, and the lines</h2>
          </div>
        </header>
        <div className="bank-intake">
          <label>
            Bank account in Zoho Books
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} disabled={!!busy}>
              {bankAccounts.length === 0 && <option value="">— sync Zoho Books first —</option>}
              {bankAccounts.map((b) => <option key={b.zoho_id} value={b.zoho_id}>{b.name}</option>)}
            </select>
          </label>
          <label className="bank-file">
            Upload a CSV, TSV, PDF or image
            <input type="file" accept=".csv,.tsv,.txt,application/pdf,image/*" disabled={!!busy || !bankAccountId} onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="bank-paste">
            …or paste the statement text (from a PDF, an email, online banking)
            <textarea rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={"Date,Description,Debit,Credit,Balance\n01/08/2026,SO TRF LANDLORD PROPERTIES,4200.00,,152340.10"} disabled={!!busy} />
          </label>
          <div className="bank-intake-actions">
            <button type="button" className="btn primary" disabled={!!busy || !pasted.trim() || !bankAccountId} onClick={() => void ingest({ source: "paste", text: pasted })}>
              {busy === "ingest" ? "Reading…" : "Read statement"}
            </button>
            <span className="muted" style={{ fontSize: ".8rem" }}>Dates are read day-first (UAE/UK). Amounts: separate debit/credit columns, a signed amount, DR/CR or brackets all work.</span>
          </div>
        </div>
      </section>

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="muted bank-notice">{notice}</p>}

      {/* ------------------------------------------------- statements */}
      {statements.length > 0 && (
        <div className="bank-statements">
          {statements.map((s) => (
            <button key={s.id} type="button" className={`bank-stmt-chip${current?.id === s.id ? " active" : ""}`} onClick={() => setCurrent(s)}>
              <b>{s.bank_account_name ?? s.bank_account_zoho_id}</b>
              <span>{s.period_start} → {s.period_end} · {s.line_count} lines · {s.source.replace("upload_", "")}</span>
            </button>
          ))}
        </div>
      )}

      {/* ------------------------------------------------- lines */}
      {current && (
        <section className="panel connection-card">
          <header className="panel-header">
            <div>
              <p className="eyebrow">{current.bank_account_name} · {current.period_start} → {current.period_end}</p>
              <h2>
                {counts.open} open{counts.suggested ? ` (${counts.suggested} with a suggestion)` : ""} · {counts.confirmed} confirmed · {counts.posted} posted
                {counts.failed ? ` · ${counts.failed} failed` : ""}{counts.skipped ? ` · ${counts.skipped} skipped` : ""}
              </h2>
            </div>
            <div className="month-nav">
              <button type="button" className="btn ghost btn-small" disabled={!!busy || counts.suggested === 0} onClick={() => void acceptAllSuggested()} title="Confirms every open line that has a complete suggestion. Still nothing goes to Zoho until you post.">
                {busy === "bulk" ? "Confirming…" : `Accept all ${counts.suggested} suggested`}
              </button>
              <button type="button" className="btn primary btn-small" disabled={!!busy || counts.confirmed === 0} onClick={() => void push()}>
                {busy === "push" ? "Posting…" : `Post ${counts.confirmed} confirmed to Zoho`}
              </button>
              <button type="button" className="btn ghost btn-small" onClick={() => setShowPosted((v) => !v)}>{showPosted ? "Hide posted" : "Show posted"}</button>
            </div>
          </header>
          {current.skipped_rows?.length > 0 && (
            <p className="muted" style={{ fontSize: ".8rem" }}>
              {current.skipped_rows.length} row{current.skipped_rows.length === 1 ? "" : "s"} not read: {current.skipped_rows.slice(0, 3).map((r) => `row ${r.row} (${r.reason})`).join(", ")}{current.skipped_rows.length > 3 ? "…" : ""}
            </p>
          )}

          <div className="tablewrap">
            <table className="usage-table bank-lines">
              <thead>
                <tr><th>#</th><th>Date</th><th>Description</th><th className="num">In</th><th className="num">Out</th><th>What is it</th><th>Who</th><th>Account / document</th><th>Why</th><th></th></tr>
              </thead>
              <tbody>
                {visible.map((l) => {
                  const d = drafts[l.id] ?? draftFrom(l);
                  const s = l.suggestion;
                  const locked = l.status === "posted" || l.status === "confirmed" || l.status === "skipped";
                  const pk = partyKindFor(d.txn_kind);
                  const partyList = pk === "customer" ? customers : pk === "vendor" ? vendors : [];
                  const partyMissing = pk && d.party_zoho_id && !partyList.some((p) => p.zoho_id === d.party_zoho_id);
                  return (
                    <tr key={l.id} className={`bank-line status-${l.status}${!s && l.status === "open" ? " no-suggestion" : ""}`}>
                      <td className="num">{l.line_no}</td>
                      <td className="num">{l.txn_date}</td>
                      <td className="bank-desc" title={l.reference ?? ""}>{l.description}{l.reference ? <small className="muted"> · {l.reference}</small> : null}</td>
                      <td className="num">{l.side === "credit" ? money(l.amount) : ""}</td>
                      <td className="num">{l.side === "debit" ? money(l.amount) : ""}</td>
                      <td>
                        {locked ? <span>{l.chosen_txn_kind ? KIND_LABEL[l.chosen_txn_kind] : "—"}</span> : (
                          <select value={d.txn_kind} onChange={(e) => setDraft(l.id, { txn_kind: e.target.value as TxnKind })} disabled={!!busy}>
                            <option value="">— choose —</option>
                            {(l.side === "credit" ? KINDS_IN : KINDS_OUT).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                          </select>
                        )}
                      </td>
                      <td>
                        {locked ? <span>{l.chosen_party_name ?? "—"}</span> : pk ? (
                          <select value={d.party_zoho_id} onChange={(e) => setDraft(l.id, { party_zoho_id: e.target.value })} disabled={!!busy}>
                            <option value="">— {partyRequired(d.txn_kind) ? pk : `${pk} (optional)`} —</option>
                            {partyMissing && s?.party_zoho_id === d.party_zoho_id && <option value={d.party_zoho_id}>{s.party_name} (from open document)</option>}
                            {partyList.map((p) => <option key={p.zoho_id} value={p.zoho_id}>{p.name}</option>)}
                          </select>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td>
                        {locked ? (
                          <span>{l.chosen_doc_number ? `${l.chosen_doc_kind === "invoice" ? "Invoice" : "Bill"} ${l.chosen_doc_number}` : l.chosen_account_name ?? "—"}</span>
                        ) : needsAccount(d.txn_kind) ? (
                          <select value={d.account_id} onChange={(e) => setDraft(l.id, { account_id: e.target.value })} disabled={!!busy}>
                            <option value="">— account —</option>
                            {accounts.map((a) => <option key={a.zoho_id} value={a.zoho_id}>{a.name}</option>)}
                          </select>
                        ) : (d.txn_kind === "customer_payment" || d.txn_kind === "vendor_payment") ? (
                          s?.doc_zoho_id ? (
                            <label className="bank-apply">
                              <input type="checkbox" checked={d.doc_zoho_id === s.doc_zoho_id} onChange={(e) => setDraft(l.id, { doc_zoho_id: e.target.checked ? s.doc_zoho_id! : "" })} disabled={!!busy} />
                              apply to {s.doc_kind === "invoice" ? "invoice" : "bill"} <b>{s.doc_number}</b> <span className="muted">(balance {money(s.doc_balance)})</span>
                            </label>
                          ) : <span className="muted">on account — no open {d.txn_kind === "customer_payment" ? "invoice" : "bill"} matched</span>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="bank-why">
                        {s ? (
                          <>
                            <span className={`status-pill bank-src bank-src-${s.source}`} title={s.reason}>{SOURCE_LABEL[s.source]} · {Math.round(s.confidence * 100)}%</span>
                            <small className="muted">{s.reason}</small>
                          </>
                        ) : l.status === "open" ? <span className="muted">nothing suggested — your call</span> : null}
                        {l.status === "posted" && <small className="muted">Zoho {l.zoho_txn_id}</small>}
                        {l.status === "failed" && <small className="error-text">{l.error}</small>}
                        {l.status === "confirmed" && <small className="muted">confirmed{l.decision === "changed_suggestion" ? " (changed)" : l.decision === "filled_blank" ? " (filled by you)" : ""} · not yet posted</small>}
                      </td>
                      <td className="bank-actions">
                        {l.status === "open" && (
                          <>
                            <button type="button" className="btn primary btn-small" disabled={!!busy || !draftComplete(d)} onClick={() => void confirm(l)}>{busy === l.id ? "…" : "Confirm"}</button>
                            <button type="button" className="btn ghost btn-small" disabled={!!busy} onClick={() => void skip(l)}>Skip</button>
                          </>
                        )}
                        {(l.status === "confirmed" || l.status === "skipped" || l.status === "failed") && (
                          <button type="button" className="btn ghost btn-small" disabled={!!busy} onClick={() => void reopen(l)}>Reopen</button>
                        )}
                        {l.status === "posted" && <span className="status-pill status-synced">posted</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: ".76rem" }}>
            Every line you confirm teaches the app what that description means the next time — as a suggestion, never as an automatic rule. Vendors and customers must already exist in Zoho Books; nothing is created from here.
          </p>
        </section>
      )}
    </main>
  );
}
