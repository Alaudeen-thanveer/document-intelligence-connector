import { useEffect, useState, useRef } from "react";
import { callEdgeFunction } from "../lib/functions";
import { todayLocalISO } from "../lib/dates";
import { PanelSection } from "./PanelSection";
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
  projectId: string;
  /** tag_id → tag_option_id */
  tags: Record<string, string>;
}

let lineKeyCounter = 0;
function nextLineKey(): string {
  lineKeyCounter += 1;
  return `line-${lineKeyCounter}`;
}

/**
 * A reporting tag in Zoho is applied either per LINE ITEM or once per
 * TRANSACTION (Zoho: multi_preference_entities.preference). We mirror that
 * exactly: line-level tags get a selector on every line; transaction-level
 * tags get ONE selector in the header and are applied uniformly to every
 * line on push — so two lines can never carry different values for a
 * transaction-level tag. Draft / inactive tags, or tags with no options,
 * cannot be applied in Zoho and are not offered.
 */
interface TagMeta {
  zoho_id: string;
  name: string;
  preference: "line_item" | "transaction";
  options: Array<{ id: string; name: string }>;
}
function tagMeta(
  rows: Array<{ zoho_id: string; name: string; extra: Record<string, unknown> | null }>,
): TagMeta[] {
  return rows
    .map((t) => {
      const extra = (t.extra ?? {}) as {
        preference?: unknown;
        is_active?: unknown;
        is_draft?: unknown;
        options?: Array<{ id: string | null; name: string | null }>;
      };
      const options = (extra.options ?? [])
        .filter((o): o is { id: string; name: string | null } => !!o.id)
        .map((o) => ({ id: o.id, name: o.name ?? o.id }));
      const usable = extra.is_active !== false && extra.is_draft !== true &&
        options.length > 0;
      return usable
        ? {
          zoho_id: t.zoho_id,
          name: t.name,
          preference: extra.preference === "transaction"
            ? "transaction" as const
            : "line_item" as const,
          options,
        }
        : null;
    })
    .filter((t): t is TagMeta => t !== null);
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
  /** Transaction-level reporting tags: tag_id → tag_option_id (one per doc). */
  const [txnTags, setTxnTags] = useState<Record<string, string>>({});
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [lineItems, setLineItems] = useState<EditableLine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Which document the fields below were last loaded for, so a live
  // refetch of THIS document does not clear the reviewer's session with it.
  const lastDocIdRef = useRef<string | null>(null);
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
    setTxnTags({});
    setInvoiceNumber(extracted?.invoice_number ?? "");
    setDueDate(extracted?.due_date ?? "");
    // Messages, the override prompt and the post-as choice belong to the
    // reviewer's session with THIS document: clear them only when the
    // selected document changes, not on every live refetch of its fields.
    if (lastDocIdRef.current !== (document?.id ?? null)) {
      setActionMsg(null);
      setZohoBillId(null);
      setPostAs("bill");
      setOverridePrompt(null);
      setOverrideReason("");
    }
    lastDocIdRef.current = document?.id ?? null;
    setPostAsTouched(false);
    setVendorId("");
    setCustomerId("");
    setAccountId("");
    setPaidThroughId("");
    setPartyRule(null);
    setAccountTouched(false);
    // Keyed on the extraction's IDENTITY, not the object. useDocumentDetail
    // builds a fresh object on every refetch, and DocumentsPage refetches on
    // any judgment_results event for ANY document in the company — so this
    // used to wipe the reviewer's typed corrections while they were still
    // typing, with no message, and Approve then wrote back the stored values.
  }, [extracted?.id, document?.id]);

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
    // Sales invoices name two parties: the issuer (vendor_raw — us) and the
    // bill-to (customer_raw). Match the customer from the bill-to first.
    const billTo = (extracted?.customer_raw ?? "").trim();
    if (!name && !billTo) {
      setMatchHint(null);
      return;
    }
    const vendorHit = name ? findByName(name, zoho.vendors, (v) => v.name) : null;
    const customerHit =
      (billTo ? findByName(billTo, zoho.customers, (c) => c.name) : null) ??
      (name ? findByName(name, zoho.customers, (c) => c.name) : null);

    // A bill-to that matches a customer outranks the issuer matching a vendor:
    // that combination means this is OUR sales invoice, not a purchase bill.
    if (customerHit && billTo) {
      setCustomerId((prev) => prev || customerHit.zoho_id);
      if (!postAsTouched) setPostAs("invoice");
      setMatchHint(
        `Bill-to matched Zoho customer "${customerHit.name}" — auto-selected Invoice.`,
      );
    } else if (vendorHit) {
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
        "No vendor or customer match. Pick the party manually — if it is genuinely new, create it in Zoho Books first, then Sync. Vendors are never created from here.",
      );
    } else {
      setMatchHint(null);
    }
  }, [vendorRaw, extracted?.customer_raw, zoho.vendors, zoho.customers, postAsTouched, document?.id]);

  // Prefill each line's project and tags from the chosen party's ACCEPTED
  // learned profiles (bk_party_project_profiles / bk_party_tag_profiles).
  // Only accepted rows prefill; proposed rows never touch the form. Never
  // overwrites a value the reviewer already set on a line.
  const learnedPartyId = postAs === "invoice" ? customerId : vendorId;
  useEffect(() => {
    if (!learnedPartyId) return;
    const kind = postAs === "invoice" ? "customer" : "vendor";
    let cancelled = false;
    void Promise.all([
      supabase
        .from("bk_party_project_profiles")
        .select("project_id")
        .eq("party_kind", kind)
        .eq("party_zoho_id", learnedPartyId)
        .eq("suggestion_status", "accepted")
        .maybeSingle(),
      supabase
        .from("bk_party_tag_profiles")
        .select("tag_id, option_id")
        .eq("party_kind", kind)
        .eq("party_zoho_id", learnedPartyId)
        .eq("suggestion_status", "accepted"),
    ]).then(([projRes, tagRes]) => {
      if (cancelled) return;
      const projectId = (projRes.data as { project_id?: string } | null)?.project_id ?? "";
      const tagDefaults = Object.fromEntries(
        ((tagRes.data ?? []) as Array<{ tag_id: string; option_id: string }>)
          .map((t) => [t.tag_id, t.option_id]),
      );
      if (!projectId && Object.keys(tagDefaults).length === 0) return;
      setLineItems((prev) =>
        prev.map((li) => ({
          ...li,
          projectId: li.projectId || projectId,
          tags: { ...tagDefaults, ...li.tags },
        }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [learnedPartyId, postAs, rulesVersion]);

  // Unused credit the chosen party holds in Zoho (advances, credit notes /
  // vendor credits). Shown as a question — "apply to this document?" —
  // and only applied on push if the reviewer ticks it. Bills and invoices
  // only; expenses are paid on the spot.
  type PartyCredit = { kind: "customerpayment" | "creditnote" | "vendorpayment" | "vendorcredit"; zoho_id: string; number: string; balance: number; date: string };
  const [partyCredits, setPartyCredits] = useState<PartyCredit[]>([]);
  const [applyCredits, setApplyCredits] = useState<Record<string, number>>({});
  // Server-side refusals the reviewer can answer: failed checks need a
  // reason; lines that do not reconcile need fixing (or an explicit
  // "post one line at the total").
  const [overridePrompt, setOverridePrompt] = useState<
    | { kind: "checks"; failed: Array<{ rule_name: string; notes: string | null }> }
    | { kind: "reconciliation"; message: string }
    | null
  >(null);
  const [overrideReason, setOverrideReason] = useState("");

  useEffect(() => {
    setPartyCredits([]);
    setApplyCredits({});
    if (!learnedPartyId || postAs === "expense") return;
    let cancelled = false;
    void callEdgeFunction("bank-statement", {
      action: "party_credits",
      party_kind: postAs === "invoice" ? "customer" : "vendor",
      party_zoho_id: learnedPartyId,
    }).then((res) => {
      if (cancelled || !res.ok) return;
      const credits = ((res.body as { credits?: PartyCredit[] }).credits ?? []).filter((c) => c.balance > 0);
      setPartyCredits(credits);
    });
    return () => {
      cancelled = true;
    };
  }, [learnedPartyId, postAs]);

  // Load the extracted line items for this document's latest extraction.
  useEffect(() => {
    if (!extracted?.id) {
      setLineItems([]);
      return;
    }
    let cancelled = false;
    void supabase
      .from("extracted_line_items")
      .select("line_no, description, quantity, rate, amount, account_zoho_id, project_zoho_id, reporting_tags")
      .eq("extracted_fields_id", extracted.id)
      .order("line_no")
      .then(({ data }) => {
        if (cancelled) return;
        // Transaction-level tags live on every line in storage; surface the
        // shared value in the header control.
        const txnIds = new Set(
          tagMeta(zoho.reportingTags)
            .filter((t) => t.preference === "transaction")
            .map((t) => t.zoho_id),
        );
        const hoisted: Record<string, string> = {};
        for (const row of data ?? []) {
          for (const t of (Array.isArray(row.reporting_tags) ? row.reporting_tags : []) as Array<{ tag_id?: string; tag_option_id?: string }>) {
            if (t?.tag_id && t?.tag_option_id && txnIds.has(t.tag_id) && !hoisted[t.tag_id]) {
              hoisted[t.tag_id] = t.tag_option_id;
            }
          }
        }
        if (Object.keys(hoisted).length) setTxnTags((prev) => ({ ...hoisted, ...prev }));
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
              projectId: row.project_zoho_id ?? "",
              tags: Object.fromEntries(
                (Array.isArray(row.reporting_tags) ? row.reporting_tags : [])
                  .filter((t: { tag_id?: string; tag_option_id?: string }) => t?.tag_id && t?.tag_option_id)
                  .map((t: { tag_id: string; tag_option_id: string }) => [t.tag_id, t.tag_option_id]),
              ),
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

  const tagMetas = tagMeta(zoho.reportingTags);
  const lineTags = tagMetas.filter((t) => t.preference === "line_item");
  const transactionTags = tagMetas.filter((t) => t.preference === "transaction");

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
  // Latest PO three-way match result (shown whether it passed or not — "matches PO X" is useful news too).
  const poMatch = judgments.find((j) => j.rule_name === "po_match") ?? null;
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
        project_zoho_id: li.projectId || null,
        // Line-level tags come from the line; transaction-level tags are the
        // single header value, applied to every line so Zoho sees them
        // consistently. A per-line value for a transaction-level tag can
        // never be entered, and is dropped here as a second guard.
        reporting_tags: [
          ...Object.entries(li.tags)
            .filter(([tag_id, opt]) =>
              opt && !transactionTags.some((t) => t.zoho_id === tag_id)
            )
            .map(([tag_id, tag_option_id]) => ({ tag_id, tag_option_id })),
          ...Object.entries(txnTags)
            .filter(([, opt]) => opt)
            .map(([tag_id, tag_option_id]) => ({ tag_id, tag_option_id })),
        ],
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

  async function approve(opts: { override?: boolean; overrideReconciliation?: boolean } = {}) {
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
    // Zoho bill mapping requires a date; default to today when OCR left it
    // blank. toISOString() is the UTC day, which for part of every day is the
    // wrong calendar date for the reviewer — and at a month boundary that is
    // the wrong VAT period.
    const dateForPush = invoiceDate.trim() || todayLocalISO();

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

    // A failed check is never silently approved: stop here and ask for a
    // written reason first. With the reason, the rows are marked as
    // overridden (who + why) and the server audits it as well.
    if (!alreadyApproved && failedRules.length > 0 && !opts.override) {
      setOverridePrompt({
        kind: "checks",
        failed: failedRules.map((r) => ({ rule_name: r.rule_name, notes: r.notes ?? null })),
      });
      setActionMsg(
        `Not posted: ${failedRules.length} failed check${failedRules.length > 1 ? "s" : ""} — posting needs a written override reason.`,
      );
      setBusy(null);
      return;
    }

    // Re-push path: status already approved after a failed Zoho call.
    if (!alreadyApproved) {
      for (const row of failedRules) {
        const { error: judgmentError } = await supabase
          .from("judgment_results")
          .update({
            passed: true,
            notes: `${row.notes ?? ""}${row.notes ? " | " : ""}Overridden by ${name}: ${overrideReason.trim()}`,
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
      const { data, error } = await supabase.functions.invoke("zoho-approve", {
        body: {
          invoice_id: document!.id,
          post_as: postAs,
          vendor_id: vendorId || undefined,
          customer_id: customerId || undefined,
          account_id: allLinesHaveAccounts ? undefined : accountId || undefined,
          paid_through_account_id: paidThroughId || undefined,
          tax_treatment: taxTreatment || undefined,
          apply_credits: Object.entries(applyCredits)
            .filter(([, amt]) => amt > 0)
            .map(([id, amt]) => {
              const c = partyCredits.find((x) => x.zoho_id === id)!;
              return { kind: c.kind, zoho_id: id, amount: amt };
            }),
          ...(opts.override ? { override: true, override_reason: overrideReason.trim() } : {}),
          ...(opts.overrideReconciliation ? { override_reconciliation: true } : {}),
        },
      });
      type ApproveResp = {
        success?: boolean;
        zoho_bill_id?: string;
        error?: string;
        failed_checks?: Array<{ rule_name: string; notes: string | null }>;
        reconciliation?: { ok: boolean; mode: string; message: string };
        money?: { tax_name: string | null; notes: string[] };
        attachment?: { uploaded: boolean; error?: string };
        already_synced?: boolean;
        einvoice?: { findings: Array<{ level: string; field: string; message: string }>; ready: boolean } | null;
      };
      // Non-2xx bodies (409 failed checks, 422 reconciliation) arrive on error.context.
      let result = (data ?? {}) as ApproveResp;
      let httpStatus = 200;
      if (error && (error as { context?: Response }).context) {
        const ctx = (error as { context: Response }).context;
        httpStatus = ctx.status;
        try { result = (await ctx.json()) as ApproveResp; } catch { /* keep */ }
      }
      if (error || !result.success) {
        const detail = result.error ?? error?.message ?? "Zoho sync failed";
        if (httpStatus === 409 && result.failed_checks?.length) {
          setOverridePrompt({ kind: "checks", failed: result.failed_checks });
          setActionMsg(`Not posted: ${detail}`);
        } else if (httpStatus === 422 && result.reconciliation) {
          setOverridePrompt({ kind: "reconciliation", message: result.reconciliation.message });
          setActionMsg(`Not posted: ${detail}`);
        } else {
          setActionMsg(
            `Zoho sync failed: ${detail}. Status is sync_failed — fix the fields and Approve again.`,
          );
        }
      } else {
        setOverridePrompt(null);
        setOverrideReason("");
        const label = postAs === "invoice"
          ? "Invoice"
          : postAs === "expense"
            ? "Expense"
            : "Bill";
        setZohoBillId(result.zoho_bill_id ?? null);
        const bits = [
          result.already_synced ? "already in Zoho — nothing new created" : null,
          result.money?.tax_name ? `VAT as ${result.money.tax_name}` : (result.money?.notes?.[0] ?? null),
          result.attachment ? (result.attachment.uploaded ? "document attached" : `attachment not uploaded${result.attachment.error ? ` (${result.attachment.error})` : ""}`) : null,
          result.reconciliation && result.reconciliation.mode !== "net" ? `lines: ${result.reconciliation.message}` : null,
          result.einvoice ? (result.einvoice.ready && !result.einvoice.findings.length ? "e-invoice fields ready" : `e-invoice fields: ${result.einvoice.findings.map((f) => `${f.level === "error" ? "⚠" : "•"} ${f.message}`).join(" ")}`) : null,
        ].filter(Boolean).join(" · ");
        setActionMsg(
          `Pushed to Zoho. ${label} ${result.zoho_bill_id ?? ""}.${bits ? ` ${bits}.` : ""}`,
        );
      }
    } catch {
      setActionMsg(
        "zoho-approve is not reachable — start `npm run functions:serve`, then click Approve → Zoho again.",
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
    <div className="review-panel">
      <dl className="rp-facts">
        <div>
          <dt>Arrived</dt>
          <dd>{document.source}</dd>
        </div>
        <div>
          <dt>Read</dt>
          <dd>
            {document.confidence != null
              ? Number(document.confidence).toFixed(2)
              : "—"}
          </dd>
        </div>
        <div>
          <dt>In Zoho</dt>
          <dd>
            {zohoBillId ??
              (document.status === "synced"
                ? "Synced — see the sync log"
                : "—")}
          </dd>
        </div>
      </dl>

      {loading && <p className="muted">Loading review details…</p>}
      {error && <p className="error-text">{error}</p>}

      <PanelSection
        id="checks"
        title="Checks"
        note={
          failedRules.length === 0
            ? "All passed"
            : `${failedRules.length} failed`
        }
        tone={failedRules.length === 0 ? "ok" : "bad"}
      >
        {failedRules.length === 0 ? (
          <p className="muted">Every check on this document passed.</p>
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
            The vendor and the account could not be matched with enough
            confidence. Correct the record below, then approve.
          </p>
        )}
      </PanelSection>

      {poMatch && (
        <PanelSection
          id="po"
          title="Purchase order"
          note={poMatch.passed ? "Matched" : "No match"}
          tone={poMatch.passed ? "ok" : "warn"}
          defaultOpen={!poMatch.passed}
        >
          <p className={poMatch.passed ? "muted" : "warn-banner"}>
            {poMatch.notes ||
              (poMatch.passed
                ? "Matches an open purchase order in Zoho Books."
                : "Does not match an open purchase order in Zoho Books.")}
          </p>
        </PanelSection>
      )}

      <PanelSection id="record" title="The record">
        {!extracted ? (
          <div>
            <p className="muted">
              Nothing has been read from this document yet — uploading it does
              not read it. Extracting needs Mindee and the edge functions.
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
                placeholder="as printed on the document"
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
              Invoice date
              <input
                type="date"
                value={invoiceDate ?? ""}
                onChange={(e) => setInvoiceDate(e.target.value)}
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
              Total amount
              <input
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.00, including VAT"
              />
            </label>
          </div>
        )}
      </PanelSection>

      {extracted && (
        <PanelSection
          id="tax"
          title="Tax"
          note={
            taxAmount.trim() === ""
              ? "No VAT on the document"
              : `VAT ${taxAmount}`
          }
        >
          <div className="form-grid">
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
        </PanelSection>
      )}

      {extracted && (
        <PanelSection
          id="lines"
          title="Lines"
          note={lineItems.length ? `${lineItems.length}` : "None read"}
          defaultOpen={lineItems.length > 0}
        >
          {lineItems.length === 0 && (
            <p className="muted">
              No line items captured — the whole amount posts as one line.
              Add lines to split it.
            </p>
          )}
          {lineItems.length > 0 && (
            <div className="line-item-head" aria-hidden="true">
              <span>Description</span>
              <span>Qty</span>
              <span>Rate</span>
            </div>
          )}
          {lineItems.map((li, idx) => (
            <div key={li.key} className="line-item-row">
              <input
                className="li-desc"
                aria-label={`Line ${idx + 1} description`}
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
                aria-label={`Line ${idx + 1} quantity`}
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
                aria-label={`Line ${idx + 1} rate`}
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
                aria-label={`Line ${idx + 1} account`}
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
              {(zoho.projects.length > 0 || lineTags.length > 0) && (
                <div className="li-dims">
                  {zoho.projects.length > 0 && (
                    <select
                      className="li-project"
                      value={li.projectId}
                      title="Project"
                      onChange={(e) =>
                        setLineItems((prev) =>
                          prev.map((p) =>
                            p.key === li.key
                              ? { ...p, projectId: e.target.value }
                              : p,
                          ),
                        )
                      }
                    >
                      <option value="">— project —</option>
                      {zoho.projects.map((pr) => (
                        <option key={pr.zoho_id} value={pr.zoho_id}>
                          {pr.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {lineTags.map((tag) => {
                    const options = tag.options;
                    return (
                      <select
                        key={tag.zoho_id}
                        className="li-tag"
                        value={li.tags[tag.zoho_id] ?? ""}
                        title={tag.name}
                        onChange={(e) =>
                          setLineItems((prev) =>
                            prev.map((p) =>
                              p.key === li.key
                                ? {
                                  ...p,
                                  tags: { ...p.tags, [tag.zoho_id]: e.target.value },
                                }
                                : p,
                            ),
                          )
                        }
                      >
                        <option value="">— {tag.name} —</option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    );
                  })}
                </div>
              )}
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
                    projectId: "",
                    tags: {},
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
        </PanelSection>
      )}

      <PanelSection id="posting" title="Posting">
        {partyCredits.length > 0 && postAs !== "expense" && (
          <div className="unused-credit">
            <p className="unused-credit-head">
              This {postAs === "invoice" ? "customer" : "vendor"} holds{" "}
              <b>{partyCredits.reduce((t, c) => t + c.balance, 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>{" "}
              of unused credit in Zoho Books. Apply it to this {postAs === "invoice" ? "invoice" : "bill"} when it posts?
            </p>
            {partyCredits.map((c) => {
              const label = c.kind === "creditnote" ? "credit note" : c.kind === "vendorcredit" ? "vendor credit" : "advance (unused payment)";
              const chosen = applyCredits[c.zoho_id] ?? 0;
              return (
                <label key={c.zoho_id} className="unused-credit-row">
                  <input
                    type="checkbox"
                    checked={chosen > 0}
                    disabled={!!busy}
                    onChange={(e) => setApplyCredits((prev) => ({ ...prev, [c.zoho_id]: e.target.checked ? c.balance : 0 }))}
                  />
                  <span>{label} <b>{c.number}</b> · {c.date}</span>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    max={c.balance}
                    value={chosen}
                    disabled={!!busy || chosen === 0}
                    onChange={(e) => setApplyCredits((prev) => ({ ...prev, [c.zoho_id]: Math.min(c.balance, Math.max(0, Number(e.target.value) || 0)) }))}
                  />
                  <small className="muted">of {c.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</small>
                </label>
              );
            })}
            <small className="muted">Nothing is applied unless ticked. Applied after the document is created, as its own step.</small>
          </div>
        )}
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
                  {postAs === "bill"
                    ? "— auto-match from Zoho vendors —"
                    : "— none —"}
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
          {transactionTags.map((tag) => (
            <label key={tag.zoho_id}>
              {tag.name}
              <select
                value={txnTags[tag.zoho_id] ?? ""}
                onChange={(e) =>
                  setTxnTags((prev) => ({ ...prev, [tag.zoho_id]: e.target.value }))
                }
                title="Applied to the whole transaction (Zoho: per-transaction tag)"
              >
                <option value="">— {tag.name} (whole transaction) —</option>
                {tag.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {transactionTags.length > 0 && (
          <p className="muted">
            {transactionTags.map((t) => t.name).join(", ")}{" "}
            {transactionTags.length === 1 ? "is" : "are"} set once per
            transaction in Zoho Books, so one value applies to every line.
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
      </PanelSection>

      {actionMsg && <p className="action-msg">{actionMsg}</p>}

      {overridePrompt?.kind === "checks" && (
        <div className="override-box">
          <p className="override-head">
            Judgment failed: {overridePrompt.failed.map((f) => f.rule_name).join(", ")}. Posting anyway is a human override and is written to the audit log with your reason.
          </p>
          <ul className="override-list">
            {overridePrompt.failed.map((f) => <li key={f.rule_name}><b>{f.rule_name}</b>{f.notes ? ` — ${f.notes}` : ""}</li>)}
          </ul>
          <label className="override-reason">
            Override reason
            <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="e.g. confirmed with supplier — not a duplicate, second delivery" disabled={!!busy} />
          </label>
          <div className="override-actions">
            <button type="button" className="btn primary" disabled={!!busy || overrideReason.trim().length < 8} onClick={() => void approve({ override: true })}>
              {busy === "approve" ? "Pushing…" : "Post anyway (override)"}
            </button>
            <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setOverridePrompt(null)}>Cancel</button>
          </div>
        </div>
      )}
      {overridePrompt?.kind === "reconciliation" && (
        <div className="override-box">
          <p className="override-head">Lines do not add up: {overridePrompt.message}.</p>
          <p className="muted" style={{ margin: 0, fontSize: ".82rem" }}>
            Fix the line items above (quantity, rate, or the total) and approve again. If the lines genuinely cannot be read, post the document total as a single line instead — the broken lines are never sent.
          </p>
          <div className="override-actions">
            <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void approve({ overrideReconciliation: true })}>
              {busy === "approve" ? "Pushing…" : "Post one line at the document total"}
            </button>
            <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setOverridePrompt(null)}>I will fix the lines</button>
          </div>
        </div>
      )}

      <div className="rp-actions">
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
    </div>
  );
}
