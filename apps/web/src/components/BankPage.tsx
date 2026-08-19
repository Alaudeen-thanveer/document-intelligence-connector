import { useCallback, useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { AppOutletContext } from "../layout/AppLayout";
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
type TxnKind =
  | "customer_payment" | "vendor_payment" | "expense" | "deposit" | "transfer" | "other"
  | "already_recorded" | "retainer_receipt"
  | "creditnote_refund" | "payment_refund" | "vendorcredit_refund" | "vendorpayment_refund"
  | "exclude";

interface ZohoMatchCandidate { transaction_id: string; transaction_type: string; date: string; amount: number; contact_name?: string | null; reference_number?: string | null }

interface Allocation {
  doc_kind: "invoice" | "bill" | "retainer";
  doc_zoho_id: string;
  doc_number: string;
  amount_applied: number;
  balance: number;
  due_date: string | null;
}

interface Suggestion {
  txn_kind: TxnKind;
  party_kind: "vendor" | "customer" | null;
  party_zoho_id: string | null;
  party_name: string | null;
  account_id: string | null;
  account_name: string | null;
  doc_kind: "invoice" | "bill" | "retainer" | null;
  doc_zoho_id: string | null;
  doc_number: string | null;
  doc_balance: number | null;
  allocations: Allocation[];
  advance_amount: number;
  bank_charges: number;
  residual: number;
  writeoff: { doc_kind: string; doc_zoho_id: string; doc_number: string; amount: number; reason: string } | null;
  ref_kind: string | null;
  ref_zoho_id: string | null;
  ref_number: string | null;
  candidates: Allocation[];
  confidence: number;
  source: "already_recorded" | "open_document" | "open_credit" | "zoho_rule" | "learned" | "accepted_rule" | "party_name";
  reason: string;
}

interface Policies {
  already_recorded_window_days: number;
  bank_charge_tolerance: Record<string, number>;
  writeoff_after_days: number | null;
  writeoff_max_amount: number | null;
  writeoff_policy_note: string | null;
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
  chosen_doc_kind: "invoice" | "bill" | "retainer" | null;
  chosen_doc_zoho_id: string | null;
  chosen_doc_number: string | null;
  chosen_allocations: Array<{ doc_kind: string; doc_zoho_id: string; doc_number: string | null; amount_applied: number }> | null;
  chosen_bank_charges: number | null;
  chosen_writeoff: boolean;
  chosen_ref_kind: string | null;
  chosen_ref_zoho_id: string | null;
  chosen_ref_number: string | null;
  decision: string | null;
  zoho_txn_id: string | null;
  zoho_extra_ids: Array<{ kind: string; zoho_id: string }> | null;
  error: string | null;
  zoho_uncategorized_id: string | null;
  zoho_payee: string | null;
  zoho_match_candidates: ZohoMatchCandidate[] | null;
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
  already_recorded: "Already recorded — link",
  retainer_receipt: "Retainer receipt",
  creditnote_refund: "Refund of credit note",
  payment_refund: "Refund of customer advance",
  vendorcredit_refund: "Refund of vendor credit",
  vendorpayment_refund: "Refund of vendor advance",
  exclude: "Exclude — not a book entry",
};
const KINDS_IN: TxnKind[] = ["customer_payment", "retainer_receipt", "vendorcredit_refund", "vendorpayment_refund", "deposit", "transfer", "already_recorded", "other"];
const KINDS_OUT: TxnKind[] = ["vendor_payment", "expense", "creditnote_refund", "payment_refund", "transfer", "already_recorded", "other"];
const FEED_EXTRA: TxnKind[] = ["exclude"];
interface RuleProposal {
  id?: string;
  fingerprint: string;
  side: "debit" | "credit";
  txn_kind: string;
  account_name: string | null;
  party_name: string | null;
  sample_size: number;
  confidence: number;
  examples?: string[];
  zoho_rule_id: string | null;
  proposable: boolean;
  why: string;
}

const SOURCE_LABEL: Record<Suggestion["source"], string> = {
  already_recorded: "already posted by this app",
  open_document: "matches an open document",
  open_credit: "matches an open credit",
  accepted_rule: "your rule",
  zoho_rule: "your Zoho bank rule",
  learned: "learned from history",
  party_name: "name only",
};
const REFUND_KINDS: TxnKind[] = ["creditnote_refund", "payment_refund", "vendorcredit_refund", "vendorpayment_refund"];

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
  /** Split across documents; edited by the reviewer. */
  allocations: Array<{ doc_kind: string; doc_zoho_id: string; doc_number: string; amount_applied: number; balance: number }>;
  bank_charges: number;
  writeoff: boolean;
  ref_kind: string;
  ref_zoho_id: string;
  ref_number: string;
}
function draftFrom(l: Line): Draft {
  const s = l.suggestion;
  if (l.status !== "open" && l.chosen_txn_kind) {
    return {
      txn_kind: l.chosen_txn_kind, party_kind: l.chosen_party_kind, party_zoho_id: l.chosen_party_zoho_id ?? "", account_id: l.chosen_account_id ?? "", doc_zoho_id: l.chosen_doc_zoho_id ?? "",
      allocations: (l.chosen_allocations ?? []).map((a) => ({ doc_kind: a.doc_kind, doc_zoho_id: a.doc_zoho_id, doc_number: a.doc_number ?? "", amount_applied: a.amount_applied, balance: 0 })),
      bank_charges: l.chosen_bank_charges ?? 0, writeoff: l.chosen_writeoff, ref_kind: l.chosen_ref_kind ?? "", ref_zoho_id: l.chosen_ref_zoho_id ?? "", ref_number: l.chosen_ref_number ?? "",
    };
  }
  return {
    txn_kind: s?.txn_kind ?? "",
    party_kind: s?.party_kind ?? null,
    party_zoho_id: s?.party_zoho_id ?? "",
    account_id: s?.account_id ?? "",
    doc_zoho_id: s?.doc_zoho_id ?? "",
    allocations: (s?.allocations ?? []).map((a) => ({ ...a })),
    bank_charges: s?.bank_charges ?? 0,
    writeoff: Boolean(s?.writeoff),
    ref_kind: s?.ref_kind ?? "",
    ref_zoho_id: s?.ref_zoho_id ?? "",
    ref_number: s?.ref_number ?? "",
  };
}
/** Which party list a kind uses (expense: vendor is optional — bank charges have none). */
function partyKindFor(kind: TxnKind | ""): "vendor" | "customer" | null {
  if (kind === "customer_payment" || kind === "deposit" || kind === "retainer_receipt" || kind === "creditnote_refund" || kind === "payment_refund") return "customer";
  if (kind === "vendor_payment" || kind === "expense" || kind === "vendorcredit_refund" || kind === "vendorpayment_refund") return "vendor";
  return null;
}
/** Receipts, payments and refunds must name who; expenses and deposits need not. */
function partyRequired(kind: TxnKind | ""): boolean {
  return kind === "customer_payment" || kind === "vendor_payment" || kind === "retainer_receipt" || REFUND_KINDS.includes(kind as TxnKind);
}
function isPayment(kind: TxnKind | ""): boolean {
  return kind === "customer_payment" || kind === "vendor_payment";
}
function sumAlloc(a: Draft["allocations"]): number {
  return Math.round(a.reduce((t, x) => t + (Number(x.amount_applied) || 0), 0) * 100) / 100;
}
function needsAccount(kind: TxnKind | ""): boolean {
  return kind === "expense" || kind === "deposit" || kind === "transfer";
}

export function BankPage() {
  const { reviewerName } = useOutletContext<AppOutletContext>();
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
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [policyDraft, setPolicyDraft] = useState<{ window: string; aed: string; usd: string; woDays: string; woAmount: string; woNote: string } | null>(null);
  const [showPolicies, setShowPolicies] = useState(false);
  const [ruleProposals, setRuleProposals] = useState<RuleProposal[] | null>(null);
  const [showRules, setShowRules] = useState(false);

  const loadRuleProposals = useCallback(async () => {
    const res = await callEdgeFunction("bank-statement", { action: "rule_proposals" });
    const body = res.body as { ok?: boolean; proposals?: RuleProposal[] };
    setRuleProposals(body.ok ? (body.proposals ?? []) : []);
  }, []);

  async function proposeRule(p: RuleProposal) {
    if (!p.id) return;
    setBusy(`rule:${p.id}`); setError(null); setNotice(null);
    const res = await callEdgeFunction("bank-statement", { action: "propose_zoho_rule", pattern_id: p.id });
    const body = res.body as { ok?: boolean; error?: string; zoho_rule_id?: string | null };
    if (!body.ok) setError(body.error ?? `Zoho rule not created (${res.status})`);
    else setNotice(`Created in Zoho Books as a suggest-only rule${body.zoho_rule_id ? ` (${body.zoho_rule_id})` : ""}. Zoho's own banking screen will now suggest the same thing; nothing is auto-posted.`);
    setBusy(null);
    await loadRuleProposals();
  }

  const loadPolicies = useCallback(async () => {
    const { data } = await supabase.from("company_config").select("already_recorded_window_days, bank_charge_tolerance, writeoff_after_days, writeoff_max_amount, writeoff_policy_note").limit(1).maybeSingle();
    if (!data) return;
    const p: Policies = {
      already_recorded_window_days: Number(data.already_recorded_window_days ?? 3),
      bank_charge_tolerance: (data.bank_charge_tolerance as Record<string, number>) ?? { AED: 5, USD: 13 },
      writeoff_after_days: data.writeoff_after_days != null ? Number(data.writeoff_after_days) : null,
      writeoff_max_amount: data.writeoff_max_amount != null ? Number(data.writeoff_max_amount) : null,
      writeoff_policy_note: (data.writeoff_policy_note as string | null) ?? null,
    };
    setPolicies(p);
    setPolicyDraft({ window: String(p.already_recorded_window_days), aed: String(p.bank_charge_tolerance.AED ?? ""), usd: String(p.bank_charge_tolerance.USD ?? ""), woDays: p.writeoff_after_days != null ? String(p.writeoff_after_days) : "", woAmount: p.writeoff_max_amount != null ? String(p.writeoff_max_amount) : "", woNote: p.writeoff_policy_note ?? "" });
  }, []);
  async function savePolicies() {
    if (!policyDraft) return;
    const tol: Record<string, number> = {};
    if (policyDraft.aed.trim()) tol.AED = Number(policyDraft.aed);
    if (policyDraft.usd.trim()) tol.USD = Number(policyDraft.usd);
    const woDays = policyDraft.woDays.trim() ? Number(policyDraft.woDays) : null;
    const woAmt = policyDraft.woAmount.trim() ? Number(policyDraft.woAmount) : null;
    if ((woDays == null) !== (woAmt == null)) { setError("Write-off policy needs both a period and a maximum amount — or leave both empty to disable."); return; }
    setBusy("policies"); setError(null);
    const { error: e } = await supabase.from("company_config").update({
      already_recorded_window_days: Math.max(0, Number(policyDraft.window) || 0),
      bank_charge_tolerance: tol, writeoff_after_days: woDays, writeoff_max_amount: woAmt, writeoff_policy_note: policyDraft.woNote.trim() || null,
    }).not("company_id", "is", null);
    setBusy(null);
    if (e) { setError(e.message); return; }
    setNotice("Policies saved. They apply to the next statement you read (or press Re-suggest on this one).");
    await loadPolicies();
  }
  async function resuggest() {
    if (!current) return;
    setBusy("suggest"); setError(null);
    const res = await callEdgeFunction("bank-statement", { action: "suggest", statement_id: current.id });
    setBusy(null);
    if (!res.ok) { setError(String(res.body.error ?? "could not re-suggest")); return; }
    setDrafts({});
    await loadLines(current.id);
  }

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

  useEffect(() => { void loadMasters(); void loadStatements(); void loadPolicies(); void loadRuleProposals(); }, [loadMasters, loadStatements, loadPolicies, loadRuleProposals]);
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
  /** FEED MODE: pull Zoho's own uncategorised transactions for the chosen account. */
  async function pullFeed() {
    if (!bankAccountId) { setError("Pick which bank account's Zoho feed to pull."); return; }
    setBusy("feed"); setError(null); setNotice(null);
    const res = await callEdgeFunction("bank-statement", { action: "pull_feed", bank_account_zoho_id: bankAccountId });
    setBusy(null);
    if (!res.ok) { setError(String(res.body.error ?? `Failed (${res.status})`)); return; }
    if (!res.body.statement_id) { setNotice(String(res.body.note ?? "Nothing new in the Zoho feed for this account.")); return; }
    const sug = res.body.suggestions as { suggested: number; open: number; zoho_matched?: number } | undefined;
    setNotice(`${res.body.line_count} uncategorised lines pulled from Zoho · ${sug?.zoho_matched ?? 0} already have a matching record in Zoho · ${sug?.suggested ?? 0} with a suggestion · ${sug?.open ?? 0} open${res.body.already_pulled ? ` · ${res.body.already_pulled} pulled earlier, skipped` : ""}. Decisions here are applied IN Zoho (match / categorise / exclude).`);
    await loadStatements();
    const { data } = await supabase.from("bank_statements").select("*").eq("id", String(res.body.statement_id)).single();
    if (data) setCurrent(data as Statement);
  }
  function pickZohoMatch(id: string, c: ZohoMatchCandidate) {
    const kind = c.transaction_type === "customer_payment" ? "customerpayment" : c.transaction_type === "vendor_payment" ? "vendorpayment" : c.transaction_type === "expense" ? "expense" : "banktransaction";
    setDraft(id, { txn_kind: "already_recorded" });
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] as Draft), txn_kind: "already_recorded", ref_kind: kind, ref_zoho_id: c.transaction_id, ref_number: c.reference_number ?? "" } }));
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
      const cur: Draft = d[id] ?? { txn_kind: "", party_kind: null, party_zoho_id: "", account_id: "", doc_zoho_id: "", allocations: [], bank_charges: 0, writeoff: false, ref_kind: "", ref_zoho_id: "", ref_number: "" };
      const next: Draft = { ...cur, ...patch };
      if (patch.txn_kind !== undefined) {
        next.party_kind = partyKindFor(patch.txn_kind);
        if (next.party_kind !== cur.party_kind) next.party_zoho_id = "";
        if (!needsAccount(patch.txn_kind)) next.account_id = "";
        if (!isPayment(patch.txn_kind) && patch.txn_kind !== "retainer_receipt") { next.doc_zoho_id = ""; next.allocations = []; next.bank_charges = 0; next.writeoff = false; }
        if (patch.txn_kind !== "already_recorded" && !REFUND_KINDS.includes(patch.txn_kind as TxnKind) && patch.txn_kind !== "retainer_receipt") { next.ref_kind = ""; next.ref_zoho_id = ""; next.ref_number = ""; }
      }
      return { ...d, [id]: next };
    });
  }
  /** Allocation editor helpers. */
  function setAllocAmount(id: string, docId: string, value: string) {
    setDrafts((d) => {
      const cur = d[id]; if (!cur) return d;
      const allocations = cur.allocations.map((a) => a.doc_zoho_id === docId ? { ...a, amount_applied: Math.max(0, Number(value) || 0) } : a);
      return { ...d, [id]: { ...cur, allocations, doc_zoho_id: allocations[0]?.doc_zoho_id ?? "" } };
    });
  }
  function addAlloc(id: string, c: Allocation) {
    setDrafts((d) => {
      const cur = d[id]; if (!cur || cur.allocations.some((a) => a.doc_zoho_id === c.doc_zoho_id)) return d;
      const line = lines.find((l) => l.id === id);
      const room = line ? Math.max(0, line.amount + (line.side === "credit" ? cur.bank_charges : 0) - sumAlloc(cur.allocations)) : 0;
      const allocations = [...cur.allocations, { doc_kind: c.doc_kind, doc_zoho_id: c.doc_zoho_id, doc_number: c.doc_number, amount_applied: Math.min(c.balance, room), balance: c.balance }];
      return { ...d, [id]: { ...cur, allocations, doc_zoho_id: allocations[0].doc_zoho_id } };
    });
  }
  function removeAlloc(id: string, docId: string) {
    setDrafts((d) => {
      const cur = d[id]; if (!cur) return d;
      const allocations = cur.allocations.filter((a) => a.doc_zoho_id !== docId);
      return { ...d, [id]: { ...cur, allocations, doc_zoho_id: allocations[0]?.doc_zoho_id ?? "" } };
    });
  }
  function nameOf(list: Entity[], id: string): string | null {
    return list.find((e) => e.zoho_id === id)?.name ?? null;
  }
  function confirmPayload(l: Line, d: Draft): Record<string, unknown> {
    const s = l.suggestion;
    const allocs = d.allocations.filter((a) => a.amount_applied > 0);
    return {
      action: "confirm", line_id: l.id, chosen_txn_kind: d.txn_kind,
      chosen_party_kind: d.party_kind, chosen_party_zoho_id: d.party_zoho_id || null,
      chosen_party_name: d.party_zoho_id ? (nameOf(d.party_kind === "customer" ? customers : vendors, d.party_zoho_id) ?? s?.party_name ?? null) : null,
      chosen_account_id: d.account_id || null, chosen_account_name: d.account_id ? nameOf(accounts, d.account_id) : null,
      chosen_allocations: allocs.map((a) => ({ doc_kind: a.doc_kind, doc_zoho_id: a.doc_zoho_id, doc_number: a.doc_number, amount_applied: a.amount_applied })),
      chosen_doc_kind: allocs[0]?.doc_kind ?? null, chosen_doc_zoho_id: allocs[0]?.doc_zoho_id ?? null, chosen_doc_number: allocs[0]?.doc_number ?? null,
      chosen_bank_charges: d.bank_charges || null,
      chosen_writeoff: d.writeoff,
      chosen_ref_kind: d.ref_kind || null, chosen_ref_zoho_id: d.ref_zoho_id || null, chosen_ref_number: d.ref_number || null,
    };
  }
  function draftProblem(l: Line, d: Draft | undefined): string | null {
    if (!d?.txn_kind) return "choose what this is first";
    if (partyRequired(d.txn_kind) && !d.party_zoho_id) return `pick the ${partyKindFor(d.txn_kind)}`;
    if (needsAccount(d.txn_kind) && !d.account_id) return "pick the account";
    if (d.txn_kind === "exclude") return null;
    if ((d.txn_kind === "already_recorded" || REFUND_KINDS.includes(d.txn_kind as TxnKind) || d.txn_kind === "retainer_receipt") && !d.ref_zoho_id) return l.zoho_match_candidates?.length ? "pick which Zoho record to match below" : "this needs the existing Zoho record it refers to — only a suggestion can supply it";
    if (isPayment(d.txn_kind)) {
      const cap = l.amount + (l.side === "credit" ? d.bank_charges : 0) + 0.005;
      if (sumAlloc(d.allocations) > cap) return `allocations (${money(sumAlloc(d.allocations))}) exceed the line`;
      if (d.allocations.some((a) => a.amount_applied > a.balance + 0.005 && a.balance > 0)) return "an allocation exceeds that document's balance";
    }
    if (d.writeoff && (!policies || policies.writeoff_after_days == null)) return "set the write-off policy first";
    return null;
  }
  async function confirm(l: Line) {
    const d = drafts[l.id];
    const problem = draftProblem(l, d);
    if (problem || !d) { setError(`Line ${l.line_no}: ${problem}.`); return; }
    setBusy(l.id); setError(null);
    const res = await callEdgeFunction("bank-statement", confirmPayload(l, d));
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
    const targets = lines.filter((l) => l.status === "open" && l.suggestion && draftComplete(drafts[l.id], l));
    if (!targets.length) return;
    setBusy("bulk"); setError(null);
    const actionId = newActionId();
    let ok = 0;
    for (const l of targets) {
      const d = drafts[l.id];
      const res = await callEdgeFunction("bank-statement", confirmPayload(l, d), { actionId });
      if (res.ok) ok++;
    }
    setBusy(null);
    setNotice(`${ok} of ${targets.length} suggested lines confirmed. Nothing has gone to Zoho yet — press “Post confirmed to Zoho”.`);
    if (current) await loadLines(current.id);
  }
  function draftComplete(d: Draft | undefined, l?: Line): boolean {
    if (!d?.txn_kind) return false;
    if (l) return draftProblem(l, d) === null;
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
            <button type="button" className="btn ghost" disabled={!!busy || !bankAccountId} onClick={() => void pullFeed()} title="Feed mode: work on the uncategorised lines Zoho already holds for this account (bank feed or a statement imported in Zoho). Decisions are applied in Zoho — match, categorise, exclude — so Zoho keeps the statement and the reconciliation.">
              {busy === "feed" ? "Pulling…" : "Pull from Zoho feed"}
            </button>
            <span className="muted" style={{ fontSize: ".8rem" }}>Dates are read day-first (UAE/UK). Amounts: separate debit/credit columns, a signed amount, DR/CR or brackets all work.</span>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- policies */}
      <section className="panel connection-card bank-policies">
        <header className="panel-header">
          <div>
            <p className="eyebrow">Policies</p>
            <h2>
              Already-recorded window {policies?.already_recorded_window_days ?? 3} days · bank charges {Object.entries(policies?.bank_charge_tolerance ?? {}).map(([c, v]) => `${c} ${v}`).join(", ") || "none"} ·
              write-off {policies?.writeoff_after_days != null ? `≤ ${money(policies.writeoff_max_amount)} after ${policies.writeoff_after_days} days` : "not set — nothing is ever proposed for write-off"}
            </h2>
          </div>
          <button type="button" className="btn ghost btn-small" onClick={() => setShowPolicies((v) => !v)}>{showPolicies ? "Close" : "Edit"}</button>
        </header>
        {showPolicies && policyDraft && (
          <div className="bank-policy-grid">
            <label>
              “Already recorded” window (days)
              <input type="number" min={0} value={policyDraft.window} onChange={(e) => setPolicyDraft({ ...policyDraft, window: e.target.value })} />
              <small className="muted">A statement line matching something this app already posted, within this many days, is linked instead of created. Only our own posts are checked — Zoho is not queried.</small>
            </label>
            <label>
              Bank-charge tolerance, AED
              <input type="number" min={0} step="0.01" value={policyDraft.aed} onChange={(e) => setPolicyDraft({ ...policyDraft, aed: e.target.value })} />
              <small className="muted">A receipt short by up to this settles the invoice in full with the gap as bank charges. Beyond it: partial.</small>
            </label>
            <label>
              Bank-charge tolerance, USD
              <input type="number" min={0} step="0.01" value={policyDraft.usd} onChange={(e) => setPolicyDraft({ ...policyDraft, usd: e.target.value })} />
              <small className="muted">Applies to USD statements. Other currencies: no bank-charge suggestion.</small>
            </label>
            <label>
              Write-off: propose after (days past due)
              <input type="number" min={0} value={policyDraft.woDays} onChange={(e) => setPolicyDraft({ ...policyDraft, woDays: e.target.value })} placeholder="not set" />
            </label>
            <label>
              Write-off: only residuals up to (amount)
              <input type="number" min={0} step="0.01" value={policyDraft.woAmount} onChange={(e) => setPolicyDraft({ ...policyDraft, woAmount: e.target.value })} placeholder="not set" />
              <small className="muted">Your IFRS-based policy — the company's decision, not the app's. Leave both empty and no write-off is ever suggested.</small>
            </label>
            <label className="bank-policy-note">
              Policy note (for the audit trail)
              <input type="text" value={policyDraft.woNote} onChange={(e) => setPolicyDraft({ ...policyDraft, woNote: e.target.value })} placeholder="e.g. IFRS 9 simplified approach; immaterial residuals written off after 90 days" />
            </label>
            <div className="bank-intake-actions">
              <button type="button" className="btn primary btn-small" disabled={busy === "policies"} onClick={() => void savePolicies()}>{busy === "policies" ? "Saving…" : "Save policies"}</button>
              {current && <button type="button" className="btn ghost btn-small" disabled={!!busy} onClick={() => void resuggest()}>{busy === "suggest" ? "Re-suggesting…" : "Re-suggest open lines"}</button>}
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------------- Zoho rule proposals */}
      {ruleProposals && ruleProposals.length > 0 && (
        <section className="panel connection-card bank-policies">
          <header className="panel-header">
            <div>
              <p className="eyebrow">Zoho bank rules</p>
              <p className="muted">
                {ruleProposals.filter((p) => p.proposable).length} learned pattern{ruleProposals.filter((p) => p.proposable).length === 1 ? "" : "s"} strong enough to become a rule in Zoho Books (≥ 90% confidence, ≥ 12 lines) ·
                {" "}{ruleProposals.filter((p) => p.zoho_rule_id).length} already proposed. Rules are created suggest-only — Zoho shows them, a human still clicks.
              </p>
            </div>
            <button type="button" className="btn ghost btn-small" onClick={() => setShowRules((v) => !v)}>{showRules ? "Close" : "Show"}</button>
          </header>
          {showRules && (
            <table className="data-table" style={{ marginTop: 10 }}>
              <thead><tr><th>Lines like</th><th>Record as</th><th>Evidence</th><th></th></tr></thead>
              <tbody>
                {ruleProposals.map((p) => (
                  <tr key={`${p.fingerprint}:${p.side}`}>
                    <td><code>{p.fingerprint}</code> <span className="muted">({p.side === "debit" ? "money out" : "money in"})</span>{p.examples?.[0] && <div className="muted"><small>e.g. {p.examples[0]}</small></div>}</td>
                    <td>{p.txn_kind.replace(/_/g, " ")}{p.account_name ? ` → ${p.account_name}` : ""}{p.party_name ? ` · ${p.party_name}` : ""}</td>
                    <td>{p.sample_size} lines · {Math.round(p.confidence * 100)}%</td>
                    <td style={{ textAlign: "right" }}>
                      {p.zoho_rule_id ? <span className="status-pill status-synced">in Zoho</span>
                        : p.proposable ? <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => void proposeRule(p)}>{busy === `rule:${p.id}` ? "Creating…" : "Create in Zoho (suggest-only)"}</button>
                        : <span className="muted"><small>{p.why}</small></span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="muted bank-notice">{notice}</p>}

      {/* ------------------------------------------------- statements */}
      {statements.length > 0 && (
        <div className="bank-statements">
          {statements.map((s) => (
            <button key={s.id} type="button" className={`bank-stmt-chip${current?.id === s.id ? " active" : ""}`} onClick={() => setCurrent(s)}>
              <b>{s.bank_account_name ?? s.bank_account_zoho_id}</b>
              <span>{s.period_start} → {s.period_end} · {s.line_count} lines · {s.source === "zoho_feed" ? "Zoho feed" : s.source.replace("upload_", "")}</span>
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
                {busy === "push" ? (current.source === "zoho_feed" ? "Applying in Zoho…" : "Posting…") : current.source === "zoho_feed" ? `Apply ${counts.confirmed} in Zoho (match · categorise · exclude)` : `Post ${counts.confirmed} confirmed to Zoho`}
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
                            {[...(l.side === "credit" ? KINDS_IN : KINDS_OUT), ...(l.zoho_uncategorized_id ? FEED_EXTRA : [])].map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
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
                      <td className="bank-alloc-cell">
                        {locked ? (
                          <span>
                            {l.chosen_allocations?.length ? l.chosen_allocations.map((a) => `${a.doc_number ?? a.doc_zoho_id} ${money(a.amount_applied)}`).join(" · ")
                              : l.chosen_ref_number || l.chosen_ref_zoho_id ? `${l.chosen_ref_kind ?? "record"} ${l.chosen_ref_number ?? l.chosen_ref_zoho_id}`
                              : l.chosen_txn_kind === "exclude" ? "excluded" : l.chosen_account_name ?? (isPayment(l.chosen_txn_kind ?? "") ? "on account (advance)" : "—")}
                            {l.chosen_bank_charges ? <small className="muted"> · bank charges {money(l.chosen_bank_charges)}</small> : null}
                            {l.chosen_writeoff ? <small className="muted"> · write-off</small> : null}
                            {l.zoho_extra_ids?.length ? <small className="muted"> · also {l.zoho_extra_ids.map((x) => x.kind).join(", ")}</small> : null}
                          </span>
                        ) : needsAccount(d.txn_kind) ? (
                          <select value={d.account_id} onChange={(e) => setDraft(l.id, { account_id: e.target.value })} disabled={!!busy}>
                            <option value="">— account —</option>
                            {accounts.map((a) => <option key={a.zoho_id} value={a.zoho_id}>{a.name}</option>)}
                          </select>
                        ) : d.txn_kind === "exclude" ? (
                          <span className="muted">will be excluded in Zoho — no book entry</span>
                        ) : d.txn_kind === "already_recorded" ? (
                          <div className="bank-alloc">
                            {d.ref_zoho_id ? <span>{l.zoho_uncategorized_id ? "match to" : "link to"} {d.ref_kind} <code>{d.ref_zoho_id}</code> — nothing new is created</span> : <span className="error-text">{l.zoho_match_candidates?.length ? "pick a Zoho record below" : "no earlier post to link to — only a suggestion can supply one"}</span>}
                            {l.zoho_match_candidates?.length ? (
                              <select value={d.ref_zoho_id} onChange={(e) => { const c = l.zoho_match_candidates!.find((x) => x.transaction_id === e.target.value); if (c) pickZohoMatch(l.id, c); }} disabled={!!busy}>
                                <option value="">Zoho suggests {l.zoho_match_candidates.length} matching record{l.zoho_match_candidates.length > 1 ? "s" : ""}…</option>
                                {l.zoho_match_candidates.map((c) => <option key={c.transaction_id} value={c.transaction_id}>{c.transaction_type.replace(/_/g, " ")} · {money(Number(c.amount))} · {c.date}{c.contact_name ? ` · ${c.contact_name}` : ""}</option>)}
                              </select>
                            ) : null}
                          </div>
                        ) : REFUND_KINDS.includes(d.txn_kind as TxnKind) || d.txn_kind === "retainer_receipt" ? (
                          d.ref_zoho_id ? <span>{d.txn_kind === "retainer_receipt" ? "retainer" : "refund of"} <b>{d.ref_number || d.ref_zoho_id}</b>{s?.doc_balance != null && d.txn_kind === "retainer_receipt" ? <span className="muted"> (balance {money(s.doc_balance)})</span> : null}</span> : <span className="error-text">needs the open credit / retainer it refers to</span>
                        ) : isPayment(d.txn_kind) ? (
                          <div className="bank-alloc">
                            {d.allocations.map((a) => (
                              <div key={a.doc_zoho_id} className="bank-alloc-row">
                                <span title={`balance ${money(a.balance)}`}>{a.doc_kind === "invoice" ? "Inv" : "Bill"} <b>{a.doc_number}</b> <small className="muted">of {money(a.balance)}</small></span>
                                <input type="number" step="0.01" min={0} value={a.amount_applied} onChange={(e) => setAllocAmount(l.id, a.doc_zoho_id, e.target.value)} disabled={!!busy} />
                                <button type="button" className="bank-x" title="remove" onClick={() => removeAlloc(l.id, a.doc_zoho_id)} disabled={!!busy}>✕</button>
                              </div>
                            ))}
                            {(s?.candidates ?? []).filter((c) => !d.allocations.some((a) => a.doc_zoho_id === c.doc_zoho_id)).length > 0 && (
                              <select value="" onChange={(e) => { const c = (s?.candidates ?? []).find((x) => x.doc_zoho_id === e.target.value); if (c) addAlloc(l.id, c); }} disabled={!!busy}>
                                <option value="">+ add another open {l.side === "credit" ? "invoice" : "bill"}…</option>
                                {(s?.candidates ?? []).filter((c) => !d.allocations.some((a) => a.doc_zoho_id === c.doc_zoho_id)).map((c) => <option key={c.doc_zoho_id} value={c.doc_zoho_id}>{c.doc_number} · {money(c.balance)}{c.due_date ? ` · due ${c.due_date}` : ""}</option>)}
                              </select>
                            )}
                            {(() => {
                              const applied = sumAlloc(d.allocations);
                              const cap = l.amount + (l.side === "credit" ? d.bank_charges : 0);
                              const unapplied = Math.round((l.amount - applied - (l.side === "debit" ? d.bank_charges : 0)) * 100) / 100;
                              return (
                                <div className="bank-alloc-sum">
                                  <span>applied {money(applied)}</span>
                                  {d.bank_charges > 0 && <span> · bank charges {money(d.bank_charges)}</span>}
                                  {applied > cap + 0.005 ? <span className="error-text"> · exceeds the line by {money(applied - cap)}</span>
                                    : unapplied > 0.005 ? <span className="bank-adv"> · {money(unapplied)} stays as an advance on account</span>
                                    : d.allocations.length === 0 ? <span className="muted"> · on account (advance) — nothing applied</span> : null}
                                  {s && s.residual > 0 && d.allocations.length > 0 && <span className="muted"> · document keeps {money(s.residual)} open</span>}
                                </div>
                              );
                            })()}
                            <div className="bank-alloc-opts">
                              {(l.side === "credit" || d.bank_charges > 0 || (s?.bank_charges ?? 0) > 0) && (
                                <label><span>bank charges</span><input type="number" step="0.01" min={0} value={d.bank_charges} onChange={(e) => setDraft(l.id, { bank_charges: Math.max(0, Number(e.target.value) || 0) })} disabled={!!busy} /></label>
                              )}
                              {s?.writeoff && (
                                <label className="bank-apply" title={s.writeoff.reason}>
                                  <input type="checkbox" checked={d.writeoff} onChange={(e) => setDraft(l.id, { writeoff: e.target.checked })} disabled={!!busy || !policies || policies.writeoff_after_days == null} />
                                  write off the {money(s.writeoff.amount)} residual on {s.writeoff.doc_number} (policy)
                                </label>
                              )}
                            </div>
                          </div>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="bank-why">
                        {s ? (
                          <>
                            <span className={`status-pill bank-src bank-src-${s.source}`} title={s.reason}>{SOURCE_LABEL[s.source]} · {Math.round(s.confidence * 100)}%</span>
                            <small className="muted">{s.reason}</small>
                          </>
                        ) : l.status === "open" ? <span className="muted">nothing suggested — your call</span> : null}
                        {l.status === "open" && l.zoho_match_candidates?.length && s?.source !== "already_recorded" ? <small className="muted">Zoho also lists {l.zoho_match_candidates.length} possible match{l.zoho_match_candidates.length > 1 ? "es" : ""} — choose “Already recorded — link” to pick one</small> : null}
                        {l.status === "posted" && <small className="muted">{l.chosen_txn_kind === "already_recorded" ? (l.zoho_uncategorized_id ? "matched in Zoho to" : "linked to") : l.chosen_txn_kind === "exclude" ? "excluded in Zoho" : l.zoho_uncategorized_id ? "categorised in Zoho as" : "Zoho"} {l.zoho_txn_id}{l.zoho_extra_ids?.length ? ` + ${l.zoho_extra_ids.map((x) => `${x.kind} ${x.zoho_id}`).join(", ")}` : ""}</small>}
                        {l.status === "failed" && <small className="error-text">{l.error}</small>}
                        {l.status === "confirmed" && <small className="muted">confirmed{l.decision === "changed_suggestion" ? " (changed)" : l.decision === "filled_blank" ? " (filled by you)" : ""} · not yet posted</small>}
                      </td>
                      <td className="bank-actions">
                        {l.status === "open" && (
                          <>
                            <button type="button" className="btn primary btn-small" disabled={!!busy || draftProblem(l, d) !== null} title={draftProblem(l, d) ?? "confirm this line"} onClick={() => void confirm(l)}>{busy === l.id ? "…" : "Confirm"}</button>
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
