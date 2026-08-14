import { useEffect, useState } from "react";
import { callEdgeFunction } from "../lib/functions";
import { supabase } from "../lib/supabase";
import { entityAccountType, findByName } from "../lib/zoho";
import { useZohoEntities } from "../hooks/useZohoEntities";
import type {
  DocumentRow,
  ExtractedFieldsRow,
  JudgmentResultRow,
} from "../types";
import { isFlaggedStatus } from "../types";

type PostAs = "bill" | "expense" | "invoice";

/** One editable invoice line in the review form. */
interface EditableLine {
  key: string;
  description: string;
  quantity: string;
  rate: string;
  accountId: string;
}

let lineKeyCounter = 0;
function nextLineKey(): string {
  lineKeyCounter += 1;
  return `line-${lineKeyCounter}`;
}

/** UAE-edition VAT treatments (transaction-level; Zoho validates). */
const TAX_TREATMENTS: Array<{ value: string; label: string }> = [
  { value: "vat_registered", label: "VAT registered" },
  { value: "vat_not_registered", label: "VAT not registered" },
  { value: "gcc_vat_registered", label: "GCC VAT registered" },
  { value: "gcc_vat_not_registered", label: "GCC VAT not registered" },
  { value: "non_gcc", label: "Non GCC" },
  { value: "dz_vat_registered", label: "Designated zone (registered)" },
  { value: "dz_vat_not_registered", label: "Designated zone (not registered)" },
];

interface Props {
  document: DocumentRow | null;
  extracted: ExtractedFieldsRow | null;
  judgments: JudgmentResultRow[];
  loading: boolean;
  error: string | null;
  reviewerName: string;
  /** Bumped by the rules manager so the vendor-rule prefill refetches. */
  rulesVersion?: number;
  onChanged: () => void;
}

export function ReviewPanel({
  document,
  extracted,
  judgments,
  loading,
  error,
  reviewerName,
  rulesVersion = 0,
  onChanged,
}: Props) {
  const [vendorRaw, setVendorRaw] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [currency, setCurrency] = useState("");
  const [taxAmount, setTaxAmount] = useState("");
  const [taxTreatment, setTaxTreatment] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [lineItems, setLineItems] = useState<EditableLine[]>([]);
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
  const [partyRule, setPartyRule] = useState<
    { account_zoho_id: string; account_name: string } | null
  >(null);
  const [accountTouched, setAccountTouched] = useState(false);

  useEffect(() => {
    setVendorRaw(extracted?.vendor_raw ?? "");
    setTotalAmount(
      extracted?.total_amount != null ? String(extracted.total_amount) : "",
    );
    setInvoiceDate(extracted?.invoice_date ?? "");
    setCurrency(extracted?.currency ?? "");
    setTaxAmount(
      extracted?.tax_amount != null ? String(extracted.tax_amount) : "",
    );
    setTaxTreatment("");
    setInvoiceNumber(extracted?.invoice_number ?? "");
    setDueDate(extracted?.due_date ?? "");
    setActionMsg(null);
    setZohoBillId(null);
    setPostAs("bill");
    setPostAsTouched(false);
    setVendorId("");
    setCustomerId("");
    setAccountId("");
    setPaidThroughId("");
    setPartyRule(null);
    setAccountTouched(false);
  }, [extracted, document?.id]);

  // Per-party default account rule (vendor for bills/expenses, customer for
  // invoices): prefill the account when the party is chosen, unless the
  // reviewer already edited the account for this transaction. The rule
  // itself is never changed by a one-off override.
  useEffect(() => {
    const isInvoice = postAs === "invoice";
    const partyId = isInvoice ? customerId : vendorId;
    if (!partyId) {
      setPartyRule(null);
      return;
    }
    let cancelled = false;
    void supabase
      .from(isInvoice ? "customer_account_rules" : "vendor_account_rules")
      .select("account_zoho_id, account_name")
      .eq(isInvoice ? "customer_zoho_id" : "vendor_zoho_id", partyId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const rule = (data ?? null) as
          | { account_zoho_id: string; account_name: string }
          | null;
        setPartyRule(rule);
        if (rule && !accountTouched) setAccountId(rule.account_zoho_id);
      });
    return () => {
      cancelled = true;
    };
  }, [vendorId, customerId, postAs, accountTouched, rulesVersion]);

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

  // Load the extracted line items for this document's latest extraction.
  useEffect(() => {
    if (!extracted?.id) {
      setLineItems([]);
      return;
    }
    let cancelled = false;
    void supabase
      .from("extracted_line_items")
      .select("line_no, description, quantity, rate, amount, account_zoho_id")
      .eq("extracted_fields_id", extracted.id)
      .order("line_no")
      .then(({ data }) => {
        if (cancelled) return;
        setLineItems(
          (data ?? []).map((row) => {
            const qty = row.quantity != null ? Number(row.quantity) : 1;
            const rate = row.rate != null
              ? Number(row.rate)
              : row.amount != null && qty > 0
                ? Number(row.amount) / qty
                : null;
            return {
              key: nextLineKey(),
              description: row.description ?? "",
              quantity: String(qty),
              rate: rate != null ? String(Math.round(rate * 100) / 100) : "",
              accountId: row.account_zoho_id ?? "",
            };
          }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [extracted?.id]);

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

  // When every line item carries its own account, the transaction-level
  // account selector is moot for bills/invoices (expenses post as a single
  // amount and still need one): show "as per line items" instead.
  const allLinesHaveAccounts = postAs !== "expense" &&
    lineItems.length > 0 &&
    lineItems.every((li) => li.accountId);
  const someLinesHaveAccounts = postAs !== "expense" &&
    !allLinesHaveAccounts &&
    lineItems.some((li) => li.accountId);

  // The selected party's treatment from the cache — shown as the default
  // option. Treatment is transactional: a VAT-registered party can still
  // have e.g. an out-of-scope document, hence the per-document dropdown.
  const selectedParty = postAs === "invoice"
    ? zoho.customers.find((c) => c.zoho_id === customerId)
    : zoho.vendors.find((v) => v.zoho_id === vendorId);
  const partyTreatment = String(
    (selectedParty?.extra as { tax_treatment?: unknown } | null)
      ?.tax_treatment ?? "",
  );
  const partyTreatmentLabel = TAX_TREATMENTS.find(
    (t) => t.value === partyTreatment,
  )?.label;

  const failedRules = judgments.filter((j) => !j.passed);
  const entityUnresolvedHint =
    isFlaggedStatus(document.status) &&
    failedRules.length === 0 &&
    document.status === "needs_review";

  /** Persist header fields + line items; returns an error message or null. */
  async function saveExtractedEdits(
    overrides?: { invoice_date?: string },
  ): Promise<string | null> {
    if (!extracted) return "No extracted fields row.";
    const { error: updateError } = await supabase
      .from("extracted_fields")
      .update({
        vendor_raw: vendorRaw.trim() || null,
        total_amount: totalAmount === "" ? null : Number(totalAmount),
        invoice_date: overrides?.invoice_date ?? (invoiceDate || null),
        currency: currency.trim().toUpperCase() || null,
        tax_amount: taxAmount === "" ? null : Number(taxAmount),
        invoice_number: invoiceNumber.trim() || null,
        due_date: dueDate || null,
      })
      .eq("id", extracted.id);
    if (updateError) return updateError.message;

    // Replace the line set with what the reviewer sees now.
    const { error: delError } = await supabase
      .from("extracted_line_items")
      .delete()
      .eq("extracted_fields_id", extracted.id);
    if (delError) return delError.message;

    const rows = lineItems
      .filter((li) => li.description.trim() || li.rate.trim())
      .map((li, i) => ({
        document_id: document!.id,
        extracted_fields_id: extracted.id,
        line_no: i + 1,
        description: li.description.trim() || null,
        quantity: li.quantity.trim() === "" ? 1 : Number(li.quantity),
        rate: li.rate.trim() === "" ? null : Number(li.rate),
        amount: li.rate.trim() === ""
          ? null
          : Number(li.rate) *
            (li.quantity.trim() === "" ? 1 : Number(li.quantity)),
        account_zoho_id: li.accountId || null,
        source: "manual" as const,
      }));
    if (rows.length > 0) {
      const { error: insError } = await supabase
        .from("extracted_line_items")
        .insert(rows);
      if (insError) return insError.message;
    }
    return null;
  }

  async function correct() {
    if (!extracted) {
      setActionMsg("No extracted fields to correct.");
      return;
    }
    setBusy("correct");
    setActionMsg(null);
    const saveErr = await saveExtractedEdits();
    if (saveErr) {
      setActionMsg(saveErr);
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

  async function savePartyRule() {
    const isInvoice = postAs === "invoice";
    const partyId = isInvoice ? customerId : vendorId;
    const party = (isInvoice ? zoho.customers : zoho.vendors).find(
      (e) => e.zoho_id === partyId,
    );
    const account = zoho.accounts.find((a) => a.zoho_id === accountId);
    if (!partyId || !party || !account) return;
    const { error: ruleError } = isInvoice
      ? await supabase.from("customer_account_rules").upsert(
          {
            customer_zoho_id: partyId,
            customer_name: party.name,
            account_zoho_id: accountId,
            account_name: account.name,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "customer_zoho_id" },
        )
      : await supabase.from("vendor_account_rules").upsert(
          {
            vendor_zoho_id: partyId,
            vendor_name: party.name,
            account_zoho_id: accountId,
            account_name: account.name,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "vendor_zoho_id" },
        );
    if (ruleError) {
      setActionMsg(`Could not save rule: ${ruleError.message}`);
      return;
    }
    setPartyRule({ account_zoho_id: accountId, account_name: account.name });
    setActionMsg(
      `Rule saved: ${party.name} now defaults to ${account.name}.`,
    );
  }

  async function removePartyRule() {
    const isInvoice = postAs === "invoice";
    const partyId = isInvoice ? customerId : vendorId;
    if (!partyId) return;
    const { error: ruleError } = await supabase
      .from(isInvoice ? "customer_account_rules" : "vendor_account_rules")
      .delete()
      .eq(isInvoice ? "customer_zoho_id" : "vendor_zoho_id", partyId);
    if (ruleError) {
      setActionMsg(`Could not remove rule: ${ruleError.message}`);
      return;
    }
    setPartyRule(null);
    setActionMsg("Default account rule removed.");
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
    const saveError = await saveExtractedEdits({ invoice_date: dateForPush });
    if (saveError) {
      setActionMsg(`Could not save fields before push: ${saveError}`);
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
        // With per-line accounts on every line, no transaction-level
        // account is sent — each line already says where it posts.
        account_id: allLinesHaveAccounts ? undefined : accountId || undefined,
        paid_through_account_id: paidThroughId || undefined,
        tax_treatment: taxTreatment || undefined,
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
            <label>
              Currency
              <input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                placeholder="AED"
                maxLength={3}
              />
            </label>
            <label>
              VAT amount
              <input
                value={taxAmount}
                onChange={(e) => setTaxAmount(e.target.value)}
                inputMode="decimal"
                placeholder="blank = no VAT on document"
              />
            </label>
            <label>
              Invoice number
              <input
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                placeholder="as printed, e.g. INV-2210"
              />
            </label>
            <label>
              Due date
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </label>
          </div>
        )}
      </section>

      {extracted && (
        <section className="section">
          <h3>Line items</h3>
          {lineItems.length === 0 && (
            <p className="muted">
              No line items captured — the whole amount posts as one line.
              Add lines to split it.
            </p>
          )}
          {lineItems.map((li, idx) => (
            <div key={li.key} className="line-item-row">
              <input
                className="li-desc"
                value={li.description}
                placeholder={`Line ${idx + 1} description`}
                onChange={(e) =>
                  setLineItems((prev) =>
                    prev.map((p) =>
                      p.key === li.key
                        ? { ...p, description: e.target.value }
                        : p,
                    ),
                  )
                }
              />
              <input
                className="li-qty"
                value={li.quantity}
                inputMode="decimal"
                placeholder="Qty"
                onChange={(e) =>
                  setLineItems((prev) =>
                    prev.map((p) =>
                      p.key === li.key
                        ? { ...p, quantity: e.target.value }
                        : p,
                    ),
                  )
                }
              />
              <input
                className="li-rate"
                value={li.rate}
                inputMode="decimal"
                placeholder="Rate"
                onChange={(e) =>
                  setLineItems((prev) =>
                    prev.map((p) =>
                      p.key === li.key ? { ...p, rate: e.target.value } : p,
                    ),
                  )
                }
              />
              <select
                className="li-account"
                value={li.accountId}
                onChange={(e) =>
                  setLineItems((prev) =>
                    prev.map((p) =>
                      p.key === li.key
                        ? { ...p, accountId: e.target.value }
                        : p,
                    ),
                  )
                }
              >
                <option value="">— account: use default —</option>
                {accountOptions.map((a) => (
                  <option key={a.zoho_id} value={a.zoho_id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <span className="li-amount">
                {(() => {
                  const q = Number(li.quantity) || 1;
                  const r = Number(li.rate);
                  return Number.isFinite(r) && li.rate.trim() !== ""
                    ? (q * r).toFixed(2)
                    : "—";
                })()}
              </span>
              <button
                type="button"
                className="btn ghost btn-small"
                onClick={() =>
                  setLineItems((prev) => prev.filter((p) => p.key !== li.key))
                }
              >
                ✕
              </button>
            </div>
          ))}
          <div className="line-items-footer">
            <button
              type="button"
              className="btn ghost btn-small"
              onClick={() =>
                setLineItems((prev) => [
                  ...prev,
                  {
                    key: nextLineKey(),
                    description: "",
                    quantity: "1",
                    rate: "",
                    accountId: "",
                  },
                ])
              }
            >
              + Add line
            </button>
            {lineItems.length > 0 && (
              <span className="muted">
                {(() => {
                  const sum = lineItems.reduce((acc, li) => {
                    const q = Number(li.quantity) || 1;
                    const r = Number(li.rate);
                    return acc +
                      (Number.isFinite(r) && li.rate.trim() !== "" ? q * r : 0);
                  }, 0);
                  const vat = taxAmount.trim() === "" ? 0 : Number(taxAmount);
                  const total = totalAmount.trim() === ""
                    ? null
                    : Number(totalAmount);
                  const expected = sum + (Number.isFinite(vat) ? vat : 0);
                  const mismatch = total != null &&
                    Math.abs(expected - total) > 0.01;
                  return `Lines ${sum.toFixed(2)} + VAT ${
                    (Number.isFinite(vat) ? vat : 0).toFixed(2)
                  } = ${expected.toFixed(2)}` +
                    (mismatch
                      ? ` — does not match total ${total?.toFixed(2)}`
                      : "");
                })()}
              </span>
            )}
          </div>
        </section>
      )}

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
                onChange={(e) => {
                  setCustomerId(e.target.value);
                  setAccountTouched(false);
                }}
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
            {allLinesHaveAccounts ? (
              <select value="" disabled>
                <option value="">as per line items</option>
              </select>
            ) : (
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
                    : someLinesHaveAccounts
                      ? "— fills lines without their own account —"
                      : "— vendor rule / review —"}
                </option>
                {accountOptions.map((a) => (
                  <option key={a.zoho_id} value={a.zoho_id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
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
          <label>
            Tax treatment
            <select
              value={taxTreatment}
              onChange={(e) => setTaxTreatment(e.target.value)}
            >
              <option value="">
                {partyTreatmentLabel
                  ? `— party default (${partyTreatmentLabel}) —`
                  : "— party default —"}
              </option>
              {TAX_TREATMENTS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {taxTreatment && partyTreatment && taxTreatment !== partyTreatment && (
          <p className="muted">
            Overriding this party's default treatment for this transaction
            only — the party master in Zoho is not changed.
          </p>
        )}

        {(postAs === "invoice" ? customerId : vendorId) && (
          <div className="rule-row">
            <span className="muted">
              {partyRule
                ? `Default account for this ${
                    postAs === "invoice" ? "customer" : "vendor"
                  }: ${partyRule.account_name}` +
                  (accountId && accountId !== partyRule.account_zoho_id
                    ? " (overridden for this transaction only)"
                    : "")
                : `No default account rule for this ${
                    postAs === "invoice" ? "customer" : "vendor"
                  } yet.`}
            </span>
            <span className="rule-actions">
              <button
                type="button"
                className="btn ghost btn-small"
                disabled={
                  !!busy ||
                  !accountId ||
                  partyRule?.account_zoho_id === accountId
                }
                onClick={() => void savePartyRule()}
              >
                {partyRule ? "Update default" : "Save as default"}
              </button>
              {partyRule && (
                <button
                  type="button"
                  className="btn ghost btn-small"
                  disabled={!!busy}
                  onClick={() => void removePartyRule()}
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
