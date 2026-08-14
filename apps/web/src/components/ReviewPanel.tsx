import { useEffect, useState } from "react";
import { callEdgeFunction } from "../lib/functions";
import { supabase } from "../lib/supabase";
import { useZohoEntities } from "../hooks/useZohoEntities";
import type {
  DocumentRow,
  ExtractedFieldsRow,
  JudgmentResultRow,
  ZohoEntityRow,
} from "../types";
import { isFlaggedStatus } from "../types";

type PostAs = "bill" | "expense" | "invoice";

/** Normalize a name for vendor/customer matching (mirrors match-entities). */
function normName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exact normalized match wins; otherwise first containment match. */
function findByName<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
): T | null {
  const q = normName(query);
  if (!q) return null;
  let containment: T | null = null;
  for (const item of items) {
    const c = normName(getName(item));
    if (!c) continue;
    if (c === q) return item;
    if (!containment && (c.includes(q) || q.includes(c))) containment = item;
  }
  return containment;
}

function entityAccountType(a: ZohoEntityRow): string {
  return String(
    (a.extra as { account_type?: unknown } | null)?.account_type ?? "",
  ).toLowerCase();
}

interface Props {
  document: DocumentRow | null;
  extracted: ExtractedFieldsRow | null;
  judgments: JudgmentResultRow[];
  loading: boolean;
  error: string | null;
  reviewerName: string;
  onChanged: () => void;
}

export function ReviewPanel({
  document,
  extracted,
  judgments,
  loading,
  error,
  reviewerName,
  onChanged,
}: Props) {
  const [vendorRaw, setVendorRaw] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [zohoBillId, setZohoBillId] = useState<string | null>(null);

  const zoho = useZohoEntities();
  const [postAs, setPostAs] = useState<PostAs>("bill");
  const [postAsTouched, setPostAsTouched] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [paidThroughId, setPaidThroughId] = useState("");
  const [matchHint, setMatchHint] = useState<string | null>(null);
  const [vendorRule, setVendorRule] = useState<
    { account_zoho_id: string; account_name: string } | null
  >(null);
  const [accountTouched, setAccountTouched] = useState(false);

  useEffect(() => {
    setVendorRaw(extracted?.vendor_raw ?? "");
    setTotalAmount(
      extracted?.total_amount != null ? String(extracted.total_amount) : "",
    );
    setInvoiceDate(extracted?.invoice_date ?? "");
    setActionMsg(null);
    setZohoBillId(null);
    setPostAs("bill");
    setPostAsTouched(false);
    setVendorId("");
    setCustomerId("");
    setAccountId("");
    setPaidThroughId("");
    setVendorRule(null);
    setAccountTouched(false);
  }, [extracted, document?.id]);

  // Per-vendor default account rule: prefill the account when a vendor is
  // chosen, unless the reviewer already edited the account for this
  // transaction. The rule itself is never changed by a one-off override.
  useEffect(() => {
    if (!vendorId) {
      setVendorRule(null);
      return;
    }
    let cancelled = false;
    void supabase
      .from("vendor_account_rules")
      .select("account_zoho_id, account_name")
      .eq("vendor_zoho_id", vendorId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const rule = (data ?? null) as
          | { account_zoho_id: string; account_name: string }
          | null;
        setVendorRule(rule);
        if (rule && !accountTouched) setAccountId(rule.account_zoho_id);
      });
    return () => {
      cancelled = true;
    };
  }, [vendorId, accountTouched]);

  // Auto-default the posting type from the extracted party name:
  // vendor match → Bill (user may still switch to Expense);
  // customer match → Invoice.
  useEffect(() => {
    const name = vendorRaw.trim();
    if (!name) {
      setMatchHint(null);
      return;
    }
    const vendorHit = findByName(name, zoho.vendors, (v) => v.name);
    const customerHit = findByName(name, zoho.customers, (c) => c.name);

    if (vendorHit) {
      setVendorId((prev) => prev || vendorHit.zoho_id);
      if (!postAsTouched) setPostAs("bill");
      setMatchHint(
        `Matched Zoho vendor "${vendorHit.name}" — defaulting to Bill. You can still post it as an Expense.`,
      );
    } else if (customerHit) {
      setCustomerId((prev) => prev || customerHit.zoho_id);
      if (!postAsTouched) setPostAs("invoice");
      setMatchHint(
        `Matched Zoho customer "${customerHit.name}" — auto-selected Invoice.`,
      );
    } else if (zoho.vendors.length + zoho.customers.length > 0) {
      setMatchHint(
        "No vendor or customer match — pick the posting type and party manually.",
      );
    } else {
      setMatchHint(null);
    }
  }, [vendorRaw, zoho.vendors, zoho.customers, postAsTouched, document?.id]);

  useEffect(() => {
    if (!document?.id) return;
    let cancelled = false;
    void supabase
      .from("erp_sync_log")
      .select("external_doc_id")
      .eq("document_id", document.id)
      .eq("source_type", "push")
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setZohoBillId(
            data?.external_doc_id != null ? String(data.external_doc_id) : null,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [document?.id, document?.status]);

  if (!document) {
    return (
      <div className="panel empty-panel">
        <h2>Review</h2>
        <p>Select a document to inspect judgment failures or unresolved matches.</p>
      </div>
    );
  }

  const accountOptions = zoho.accounts.filter((a) => {
    const t = entityAccountType(a);
    if (!t) return true;
    if (postAs === "invoice") return t.includes("income");
    return t.includes("expense") || t.includes("cost_of_goods");
  });

  const paidThroughOptions = zoho.accounts.filter((a) => {
    const t = entityAccountType(a);
    return t.includes("bank") || t.includes("cash") || t === "credit_card";
  });

  const failedRules = judgments.filter((j) => !j.passed);
  const entityUnresolvedHint =
    isFlaggedStatus(document.status) &&
    failedRules.length === 0 &&
    document.status === "needs_review";

  async function correct() {
    if (!extracted) {
      setActionMsg("No extracted fields to correct.");
      return;
    }
    setBusy("correct");
    setActionMsg(null);
    const { error: updateError } = await supabase
      .from("extracted_fields")
      .update({
        vendor_raw: vendorRaw.trim() || null,
        total_amount: totalAmount === "" ? null : Number(totalAmount),
        invoice_date: invoiceDate || null,
      })
      .eq("id", extracted.id);

    if (updateError) {
      setActionMsg(updateError.message);
      setBusy(null);
      return;
    }

    await supabase
      .from("documents")
      .update({ status: "needs_review" })
      .eq("id", document!.id);

    setActionMsg("Corrections saved. Approve when ready to push.");
    setBusy(null);
    onChanged();
  }

  async function saveVendorRule() {
    if (!vendorId || !accountId) return;
    const vendor = zoho.vendors.find((v) => v.zoho_id === vendorId);
    const account = zoho.accounts.find((a) => a.zoho_id === accountId);
    if (!vendor || !account) return;
    const { error: ruleError } = await supabase
      .from("vendor_account_rules")
      .upsert(
        {
          vendor_zoho_id: vendorId,
          vendor_name: vendor.name,
          account_zoho_id: accountId,
          account_name: account.name,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "vendor_zoho_id" },
      );
    if (ruleError) {
      setActionMsg(`Could not save vendor rule: ${ruleError.message}`);
      return;
    }
    setVendorRule({ account_zoho_id: accountId, account_name: account.name });
    setActionMsg(
      `Rule saved: ${vendor.name} now defaults to ${account.name}.`,
    );
  }

  async function removeVendorRule() {
    if (!vendorId) return;
    const { error: ruleError } = await supabase
      .from("vendor_account_rules")
      .delete()
      .eq("vendor_zoho_id", vendorId);
    if (ruleError) {
      setActionMsg(`Could not remove vendor rule: ${ruleError.message}`);
      return;
    }
    setVendorRule(null);
    setActionMsg("Vendor default rule removed.");
  }

  async function runExtractAndJudgment() {
    if (!document) return;
    setBusy("process");
    setActionMsg(null);
    try {
      const extract = await callEdgeFunction("extract", {
        document_id: document.id,
      });
      if (!extract.ok) {
        setActionMsg(
          `Extract failed: ${
            extract.body.error ?? extract.body.reason ?? extract.status
          }. Ensure functions serve is running.`,
        );
        setBusy(null);
        return;
      }
      const judgment = await callEdgeFunction("judgment", {
        document_id: document.id,
      });
      if (!judgment.ok) {
        setActionMsg(
          `Judgment failed: ${
            judgment.body.error ?? judgment.body.reason ?? judgment.status
          }`,
        );
        setBusy(null);
        onChanged();
        return;
      }
      setActionMsg(
        "Extract + judgment finished. Fields and rules should appear below.",
      );
      onChanged();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : String(err));
    }
    setBusy(null);
  }

  async function approve() {
    if (!extracted) {
      setActionMsg(
        "Cannot approve: run extract first (no extracted_fields for this document).",
      );
      return;
    }
    if (!vendorRaw.trim() || totalAmount.trim() === "") {
      setActionMsg(
        "Fill Vendor and Total amount, then Approve → Zoho. Empty fields cannot create a Zoho bill.",
      );
      return;
    }
    const amountNum = Number(totalAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setActionMsg("Total amount must be a positive number.");
      return;
    }
    if (postAs === "invoice" && !customerId) {
      setActionMsg("Select the customer to post this invoice to.");
      return;
    }
    if (postAs === "expense" && !accountId) {
      setActionMsg("Select the expense account to post to.");
      return;
    }
    if (postAs === "expense" && !paidThroughId) {
      setActionMsg(
        "Select the bank/cash account the expense was paid through.",
      );
      return;
    }

    setBusy("approve");
    setActionMsg(null);
    const name = reviewerName.trim() || "reviewer";
    // Zoho bill mapping requires a date; default to today when OCR left it blank.
    const dateForPush =
      invoiceDate.trim() || new Date().toISOString().slice(0, 10);

    // Persist form values before push — zoho-push reads DB, not the UI inputs.
    const { error: saveError } = await supabase
      .from("extracted_fields")
      .update({
        vendor_raw: vendorRaw.trim(),
        total_amount: amountNum,
        invoice_date: dateForPush,
      })
      .eq("id", extracted.id);
    if (saveError) {
      setActionMsg(`Could not save fields before push: ${saveError.message}`);
      setBusy(null);
      return;
    }
    if (!invoiceDate.trim()) setInvoiceDate(dateForPush);

    const alreadyApproved =
      document!.status === "approved" || document!.status === "synced";

    // Re-push path: status already approved after a failed Zoho call.
    if (!alreadyApproved) {
      for (const row of failedRules) {
        const { error: judgmentError } = await supabase
          .from("judgment_results")
          .update({
            passed: true,
            notes: `${row.notes ?? ""}${row.notes ? " | " : ""}Approved by ${name}`,
            reviewed_by: name,
          })
          .eq("id", row.id);
        if (judgmentError) {
          setActionMsg(judgmentError.message);
          setBusy(null);
          return;
        }
      }

      // Record an explicit review approval when the flag was entity-unresolved only.
      if (failedRules.length === 0) {
        await supabase.from("judgment_results").insert({
          document_id: document!.id,
          rule_name: "human_review_approval",
          passed: true,
          notes: "Reviewer approved for Zoho push",
          reviewed_by: name,
        });
      }

      const { error: statusError } = await supabase
        .from("documents")
        .update({ status: "approved" })
        .eq("id", document!.id);

      if (statusError) {
        setActionMsg(statusError.message);
        setBusy(null);
        return;
      }
    }

    try {
      const push = await callEdgeFunction("zoho-push", {
        document_id: document!.id,
        post_as: postAs,
        vendor_id: vendorId || undefined,
        customer_id: customerId || undefined,
        account_id: accountId || undefined,
        paid_through_account_id: paidThroughId || undefined,
      });
      if (!push.ok) {
        const detail = String(
          push.body.error ?? push.body.reason ?? push.status,
        );
        const gatewayHint =
          push.status === 502 ||
          /invalid response|upstream/i.test(detail)
            ? " Edge Functions runtime was down or restarting — keep `npx supabase functions serve --env-file .env` running, then click Approve → Zoho again."
            : "";
        setActionMsg(
          `Approved in app, but Zoho push failed: ${detail}.${gatewayHint} Status stays approved until a successful push sets synced.`,
        );
      } else {
        const attach = push.body.attachment as
          | { present_on_bill?: boolean; uploaded?: boolean }
          | undefined;
        const attachOk = Boolean(attach?.present_on_bill ?? attach?.uploaded);
        const docId = String(push.body.external_doc_id ?? "");
        const label = postAs === "invoice"
          ? "Invoice"
          : postAs === "expense"
            ? "Expense"
            : "Bill";
        setZohoBillId(docId || null);
        setActionMsg(
          `Pushed to Zoho. ${label} ${docId}` +
            (attachOk ? " — attachment present." : " — attachment not confirmed.") +
            ` Check Zoho Books → ${label}s, or Studio table erp_sync_log.`,
        );
      }
    } catch {
      setActionMsg(
        "Approved in app. Zoho push function is not reachable — start `npx supabase functions serve --env-file .env`, then click Approve → Zoho again.",
      );
    }

    setBusy(null);
    onChanged();
  }

  async function reject() {
    setBusy("reject");
    setActionMsg(null);
    const name = reviewerName.trim() || "reviewer";

    const { error: insertError } = await supabase.from("judgment_results").insert({
      document_id: document!.id,
      rule_name: "human_review_rejection",
      passed: false,
      notes: "Rejected by reviewer before Zoho push",
      reviewed_by: name,
    });
    if (insertError) {
      setActionMsg(insertError.message);
      setBusy(null);
      return;
    }

    const { error: statusError } = await supabase
      .from("documents")
      .update({ status: "rejected" })
      .eq("id", document!.id);

    if (statusError) {
      setActionMsg(statusError.message);
      setBusy(null);
      return;
    }

    setActionMsg("Document rejected.");
    setBusy(null);
    onChanged();
  }

  return (
    <div className="panel review-panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Selected document</p>
          <h2>{document.doc_type ?? "Document"}</h2>
        </div>
        <span className={`status-pill status-${document.status}`}>
          {document.status}
        </span>
      </header>

      <dl className="meta-grid">
        <div>
          <dt>Source</dt>
          <dd>{document.source}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>
            {document.confidence != null
              ? Number(document.confidence).toFixed(2)
              : "—"}
          </dd>
        </div>
        <div>
          <dt>File</dt>
          <dd className="truncate">
            <a href={document.file_url} target="_blank" rel="noreferrer">
              Open file
            </a>
          </dd>
        </div>
        <div>
          <dt>Zoho bill</dt>
          <dd>{zohoBillId ?? (document.status === "synced" ? "synced (see erp_sync_log)" : "—")}</dd>
        </div>
      </dl>

      {loading && <p className="muted">Loading review details…</p>}
      {error && <p className="error-text">{error}</p>}

      <section className="section">
        <h3>Judgment failures</h3>
        {failedRules.length === 0 ? (
          <p className="muted">No failed judgment rules.</p>
        ) : (
          <ul className="rule-list">
            {failedRules.map((rule) => (
              <li key={rule.id}>
                <strong>{rule.rule_name}</strong>
                <span>{rule.notes || "No notes"}</span>
              </li>
            ))}
          </ul>
        )}
        {entityUnresolvedHint && (
          <p className="warn-banner">
            Entity match unresolved — vendor and/or GL account could not be
            auto-matched with enough confidence. Correct fields below, then
            approve for push.
          </p>
        )}
      </section>

      <section className="section">
        <h3>Correct extracted fields</h3>
        {!extracted ? (
          <div>
            <p className="muted">
              No extracted_fields yet — upload alone does not read the invoice.
              Run extract (needs Mindee + functions serve).
            </p>
            <button
              type="button"
              className="btn primary"
              style={{ marginTop: "0.75rem" }}
              disabled={!!busy}
              onClick={() => void runExtractAndJudgment()}
            >
              {busy === "process" ? "Processing…" : "Run extract + judgment"}
            </button>
          </div>
        ) : (
          <div className="form-grid">
            <label>
              Vendor
              <input
                value={vendorRaw}
                onChange={(e) => setVendorRaw(e.target.value)}
              />
            </label>
            <label>
              Total amount
              <input
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <label>
              Invoice date
              <input
                type="date"
                value={invoiceDate ?? ""}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </label>
          </div>
        )}
      </section>

      <section className="section">
        <h3>Post to Zoho</h3>
        <div className="zoho-sync-row">
          <p className="muted">
            {zoho.loading
              ? "Loading Zoho cache…"
              : zoho.vendors.length + zoho.customers.length +
                    zoho.accounts.length === 0
                ? "No Zoho data cached yet — sync to load accounts, vendors and customers."
                : `${zoho.vendors.length} vendors · ${zoho.customers.length} customers · ${zoho.accounts.length} accounts cached.`}
          </p>
          <button
            type="button"
            className="btn ghost"
            disabled={zoho.syncing || !!busy}
            onClick={() => void zoho.sync()}
          >
            {zoho.syncing ? "Syncing…" : "Sync from Zoho"}
          </button>
        </div>
        {zoho.error && <p className="error-text">{zoho.error}</p>}

        <div className="radio-row">
          {(["bill", "expense", "invoice"] as const).map((kind) => (
            <label
              key={kind}
              className={`radio-pill${postAs === kind ? " active" : ""}`}
            >
              <input
                type="radio"
                name="post-as"
                checked={postAs === kind}
                onChange={() => {
                  setPostAs(kind);
                  setPostAsTouched(true);
                  setAccountId("");
                  setAccountTouched(false);
                }}
              />
              {kind === "bill"
                ? "Bill"
                : kind === "expense"
                  ? "Expense"
                  : "Invoice"}
            </label>
          ))}
        </div>
        {matchHint && <p className="muted">{matchHint}</p>}

        <div className="form-grid">
          {postAs !== "invoice" && (
            <label>
              Vendor
              <select
                value={vendorId}
                onChange={(e) => {
                  setVendorId(e.target.value);
                  setAccountTouched(false);
                }}
              >
                <option value="">
                  {postAs === "bill" ? "— auto (create if new) —" : "— none —"}
                </option>
                {zoho.vendors.map((v) => (
                  <option key={v.zoho_id} value={v.zoho_id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {postAs === "invoice" && (
            <label>
              Customer
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">— select customer —</option>
                {zoho.customers.map((c) => (
                  <option key={c.zoho_id} value={c.zoho_id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {postAs === "invoice" ? "Income account" : "Expense account"}
            <select
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                setAccountTouched(true);
              }}
            >
              <option value="">
                {postAs === "expense"
                  ? "— select account —"
                  : "— vendor rule / review —"}
              </option>
              {accountOptions.map((a) => (
                <option key={a.zoho_id} value={a.zoho_id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {postAs === "expense" && (
            <label>
              Paid through
              <select
                value={paidThroughId}
                onChange={(e) => setPaidThroughId(e.target.value)}
              >
                <option value="">— select bank/cash —</option>
                {paidThroughOptions.map((a) => (
                  <option key={a.zoho_id} value={a.zoho_id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {postAs !== "invoice" && vendorId && (
          <div className="rule-row">
            <span className="muted">
              {vendorRule
                ? `Default account for this vendor: ${vendorRule.account_name}` +
                  (accountId && accountId !== vendorRule.account_zoho_id
                    ? " (overridden for this transaction only)"
                    : "")
                : "No default account rule for this vendor yet."}
            </span>
            <span className="rule-actions">
              <button
                type="button"
                className="btn ghost btn-small"
                disabled={
                  !!busy ||
                  !accountId ||
                  vendorRule?.account_zoho_id === accountId
                }
                onClick={() => void saveVendorRule()}
              >
                {vendorRule ? "Update default" : "Save as default"}
              </button>
              {vendorRule && (
                <button
                  type="button"
                  className="btn ghost btn-small"
                  disabled={!!busy}
                  onClick={() => void removeVendorRule()}
                >
                  Remove
                </button>
              )}
            </span>
          </div>
        )}
      </section>

      <div className="actions">
        <button
          type="button"
          className="btn ghost"
          disabled={!!busy || !extracted}
          onClick={() => void correct()}
        >
          {busy === "correct" ? "Saving…" : "Correct"}
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={!!busy}
          onClick={() => void reject()}
        >
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!!busy || !extracted || document.status === "synced"}
          onClick={() => void approve()}
        >
          {busy === "approve"
            ? "Pushing…"
            : document.status === "approved" && !zohoBillId
              ? "Retry Zoho push"
              : "Approve → Zoho"}
        </button>
      </div>

      {actionMsg && <p className="action-msg">{actionMsg}</p>}
    </div>
  );
}
