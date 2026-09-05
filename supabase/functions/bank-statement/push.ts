/**
 * Bank layer 4 + phase 1: post ONE confirmed statement line to Zoho Books.
 *
 * Only `chosen_*` values are used — never the suggestion — and the caller
 * only sends lines whose status is 'confirmed'. Shapes:
 *   customer_payment  → POST /customerpayments with invoices[] from the
 *                       chosen allocations (any remainder is Zoho's
 *                       unused_amount = advance) and bank_charges if chosen
 *   vendor_payment    → POST /vendorpayments with bills[]; a vendor-side
 *                       bank charge becomes a second record: an expense
 *   retainer_receipt  → POST /customerpayments with retainerinvoice_id
 *   expense           → POST /expenses (bank → chosen expense account)
 *   deposit/transfer  → POST /banktransactions
 *   creditnote_refund / payment_refund / vendorcredit_refund /
 *   vendorpayment_refund → the matching /refunds endpoint
 *   already_recorded  → nothing is created; the line is linked to the
 *                       existing Zoho id
 * A chosen write-off adds POST /{invoices|bills}/{id}/writeoff for the
 * residual after the payment posts. Extra records are returned so the
 * caller can keep every id.
 */

export interface ConfirmedLine {
  id: string;
  line_no: number;
  txn_date: string;
  description: string;
  reference: string | null;
  side: "debit" | "credit";
  amount: number;
  chosen_txn_kind: string;
  chosen_party_kind: string | null;
  chosen_party_zoho_id: string | null;
  chosen_account_id: string | null;
  chosen_doc_kind: string | null;
  chosen_doc_zoho_id: string | null;
  chosen_allocations: Array<{ doc_kind: string; doc_zoho_id: string; doc_number?: string; amount_applied: number }> | null;
  chosen_bank_charges: number | null;
  chosen_writeoff: boolean;
  chosen_ref_kind: string | null;
  chosen_ref_zoho_id: string | null;
  suggestion?: { writeoff?: { doc_kind: string; doc_zoho_id: string; amount: number } | null } | null;
}

export interface PushResult {
  kind: string;
  zoho_id: string;
  payload: Record<string, unknown>;
  extra: Array<{ kind: string; zoho_id: string }>;
}

async function zohoPost(zohoFetch: typeof fetch, apiBase: string, orgId: string, token: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await zohoFetch(`${apiBase}/${path}?organization_id=${encodeURIComponent(orgId)}`, {
    method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code != null && j.code !== 0)) {
    throw new Error(`Zoho ${path} rejected: ${j.message ?? res.status}${j.code != null ? ` (code ${j.code})` : ""}`);
  }
  return j;
}

/** Bank-fee account for vendor-side charges: passed by the caller from settings/cache. */
export interface PushOptions {
  bankChargesAccountId?: string | null;
}

export async function pushLine(
  zohoFetch: typeof fetch, apiBase: string, orgId: string, token: string,
  line: ConfirmedLine, bankAccountId: string, opts: PushOptions = {},
): Promise<PushResult> {
  const amount = Math.round(Number(line.amount) * 100) / 100;
  const common = {
    date: line.txn_date,
    reference_number: (line.reference ?? "").slice(0, 100) || undefined,
    description: line.description.slice(0, 500),
  };
  const kind = line.chosen_txn_kind;
  const allocations = (line.chosen_allocations ?? []).filter((a) => a.doc_zoho_id && Number(a.amount_applied) > 0);
  const extra: Array<{ kind: string; zoho_id: string }> = [];
  const post = (path: string, body: Record<string, unknown>) => zohoPost(zohoFetch, apiBase, orgId, token, path, body);

  // Write-off of the residual on the last allocated document, if chosen.
  async function maybeWriteoff(): Promise<void> {
    if (!line.chosen_writeoff) return;
    const w = line.suggestion?.writeoff;
    const target = w?.doc_zoho_id ? w : (allocations.length ? { doc_kind: allocations[allocations.length - 1].doc_kind, doc_zoho_id: allocations[allocations.length - 1].doc_zoho_id, amount: 0 } : null);
    if (!target) return;
    const path = target.doc_kind === "bill" ? `bills/${target.doc_zoho_id}/writeoff` : `invoices/${target.doc_zoho_id}/writeoff`;
    await post(path, {});
    extra.push({ kind: "writeoff", zoho_id: target.doc_zoho_id });
  }

  // ------------------------------------------------------ already recorded
  if (kind === "already_recorded") {
    if (!line.chosen_ref_zoho_id) throw new Error("already-recorded link needs the existing Zoho id");
    return { kind, zoho_id: line.chosen_ref_zoho_id, payload: { linked_to: line.chosen_ref_kind, id: line.chosen_ref_zoho_id }, extra };
  }

  // ------------------------------------------------- customer side money in
  if (kind === "customer_payment" || kind === "retainer_receipt") {
    if (!line.chosen_party_zoho_id) throw new Error("customer receipt needs a customer");
    if (line.side !== "credit") throw new Error("a customer receipt must be money IN");
    const bankCharges = Math.round(Number(line.chosen_bank_charges ?? 0) * 100) / 100;
    // Zoho semantics (verified live): `amount` is what the CUSTOMER paid
    // (invoice side, = line + bank charges); `bank_charges` is what the bank
    // kept; the deposit into the bank account is amount − bank_charges =
    // the statement line. Sending the line amount as `amount` with charges
    // on top makes Zoho reject the invoice application.
    const body: Record<string, unknown> = {
      customer_id: line.chosen_party_zoho_id, payment_mode: "banktransfer",
      amount: Math.round((amount + bankCharges) * 100) / 100, account_id: bankAccountId, ...common,
    };
    if (bankCharges > 0) body.bank_charges = bankCharges;
    if (kind === "retainer_receipt") {
      const rid = line.chosen_ref_zoho_id ?? line.chosen_doc_zoho_id;
      if (!rid) throw new Error("retainer receipt needs the retainer invoice");
      body.retainerinvoice_id = rid;
    } else if (allocations.length) {
      body.invoices = allocations.filter((a) => a.doc_kind === "invoice").map((a) => ({ invoice_id: a.doc_zoho_id, amount_applied: Math.round(Number(a.amount_applied) * 100) / 100 }));
    } else if (line.chosen_doc_kind === "invoice" && line.chosen_doc_zoho_id) {
      body.invoices = [{ invoice_id: line.chosen_doc_zoho_id, amount_applied: amount }];
    }
    const j = await post("customerpayments", body);
    const p = (j.payment ?? {}) as Record<string, unknown>;
    await maybeWriteoff();
    return { kind, zoho_id: String(p.payment_id ?? ""), payload: p, extra };
  }

  // ------------------------------------------------- vendor side money out
  if (kind === "vendor_payment") {
    if (!line.chosen_party_zoho_id) throw new Error("vendor payment needs a vendor");
    if (line.side !== "debit") throw new Error("a vendor payment must be money OUT");
    const bankCharges = Math.round(Number(line.chosen_bank_charges ?? 0) * 100) / 100;
    // Vendor payments carry no bank_charges field: the vendor received
    // amount − charges; the charge is our expense.
    const paid = Math.round((amount - bankCharges) * 100) / 100;
    const body: Record<string, unknown> = {
      vendor_id: line.chosen_party_zoho_id, payment_mode: "banktransfer", amount: paid,
      paid_through_account_id: bankAccountId, ...common,
    };
    if (allocations.length) {
      body.bills = allocations.filter((a) => a.doc_kind === "bill").map((a) => ({ bill_id: a.doc_zoho_id, amount_applied: Math.round(Number(a.amount_applied) * 100) / 100 }));
    } else if (line.chosen_doc_kind === "bill" && line.chosen_doc_zoho_id) {
      body.bills = [{ bill_id: line.chosen_doc_zoho_id, amount_applied: paid }];
    }
    const j = await post("vendorpayments", body);
    const p = (j.vendorpayment ?? {}) as Record<string, unknown>;
    if (bankCharges > 0) {
      if (!opts.bankChargesAccountId) throw new Error("bank charges chosen but no Bank Fees account is known — sync accounts");
      const e = await post("expenses", { account_id: opts.bankChargesAccountId, paid_through_account_id: bankAccountId, amount: bankCharges, date: line.txn_date, description: `Bank charges on ${line.description.slice(0, 80)}` });
      extra.push({ kind: "bank_charges_expense", zoho_id: String(((e.expense ?? {}) as Record<string, unknown>).expense_id ?? "") });
    }
    await maybeWriteoff();
    return { kind, zoho_id: String(p.payment_id ?? ""), payload: p, extra };
  }

  // ------------------------------------------------------------ refunds
  if (kind === "creditnote_refund" || kind === "payment_refund" || kind === "vendorcredit_refund" || kind === "vendorpayment_refund") {
    if (!line.chosen_ref_zoho_id) throw new Error("a refund needs the credit or payment being refunded");
    const refundBody = { date: line.txn_date, refund_mode: "banktransfer", amount, reference_number: common.reference_number, description: common.description };
    let path: string, key: string, idKey: string;
    if (kind === "creditnote_refund") { if (line.side !== "debit") throw new Error("a credit-note refund is money OUT"); path = `creditnotes/${line.chosen_ref_zoho_id}/refunds`; key = "creditnote_refund"; idKey = "creditnote_refund_id"; Object.assign(refundBody, { from_account_id: bankAccountId }); }
    else if (kind === "payment_refund") { if (line.side !== "debit") throw new Error("a payment refund is money OUT"); path = `customerpayments/${line.chosen_ref_zoho_id}/refunds`; key = "payment_refund"; idKey = "payment_refund_id"; Object.assign(refundBody, { from_account_id: bankAccountId }); }
    else if (kind === "vendorcredit_refund") { if (line.side !== "credit") throw new Error("a vendor-credit refund is money IN"); path = `vendorcredits/${line.chosen_ref_zoho_id}/refunds`; key = "vendor_credit_refund"; idKey = "vendor_credit_refund_id"; Object.assign(refundBody, { account_id: bankAccountId }); }
    else { if (line.side !== "credit") throw new Error("a vendor-payment refund is money IN"); path = `vendorpayments/${line.chosen_ref_zoho_id}/refunds`; key = "vendorpayment_refund"; idKey = "vendorpayment_refund_id"; Object.assign(refundBody, { account_id: bankAccountId }); }
    const j = await post(path, refundBody);
    const r = ((j[key] ?? j.refund ?? {}) as Record<string, unknown>);
    return { kind, zoho_id: String(r[idKey] ?? r.refund_id ?? ""), payload: r, extra };
  }

  // ------------------------------------------------------------ expense
  if (kind === "expense") {
    if (!line.chosen_account_id) throw new Error("expense needs an account");
    if (line.side !== "debit") throw new Error("an expense must be money OUT");
    const body: Record<string, unknown> = { account_id: line.chosen_account_id, paid_through_account_id: bankAccountId, amount, ...common };
    if (line.chosen_party_kind === "vendor" && line.chosen_party_zoho_id) body.vendor_id = line.chosen_party_zoho_id;
    const j = await post("expenses", body);
    const e = (j.expense ?? {}) as Record<string, unknown>;
    return { kind, zoho_id: String(e.expense_id ?? ""), payload: e, extra };
  }

  // ------------------------------------------------- deposit / transfer
  if (kind === "deposit" || kind === "transfer") {
    if (!line.chosen_account_id) throw new Error(`${kind} needs an account`);
    let body: Record<string, unknown>;
    if (kind === "deposit") {
      body = { transaction_type: "deposit", from_account_id: line.chosen_account_id, to_account_id: bankAccountId, amount, payment_mode: "banktransfer", ...common };
      if (line.chosen_party_kind === "customer" && line.chosen_party_zoho_id) body.customer_id = line.chosen_party_zoho_id;
    } else {
      body = line.side === "debit"
        ? { transaction_type: "transfer_fund", from_account_id: bankAccountId, to_account_id: line.chosen_account_id, amount, ...common }
        : { transaction_type: "transfer_fund", from_account_id: line.chosen_account_id, to_account_id: bankAccountId, amount, ...common };
    }
    const j = await post("banktransactions", body);
    const t = (j.banktransaction ?? {}) as Record<string, unknown>;
    return { kind, zoho_id: String(t.transaction_id ?? ""), payload: t, extra };
  }

  throw new Error("choose what this line is (receipt, payment, refund, expense, deposit or transfer) before posting");
}
