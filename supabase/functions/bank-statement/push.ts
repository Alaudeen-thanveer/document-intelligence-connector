/**
 * Bank layer 4: post ONE confirmed statement line to Zoho Books.
 *
 * Only `chosen_*` values are used — never the suggestion — and the caller
 * only sends lines whose status is 'confirmed'. Four shapes:
 *   customer_payment → POST /customerpayments  (applied to the chosen
 *                      invoice when one was picked; else on account)
 *   vendor_payment   → POST /vendorpayments    (applied to the chosen bill)
 *   expense          → POST /banktransactions type=expense
 *                      (bank → chosen expense account, optional vendor)
 *   deposit          → POST /banktransactions type=deposit
 *                      (chosen income account → bank, optional customer)
 *   transfer         → POST /banktransactions type=transfer_fund
 * The statement's bank account is always one side of the entry.
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
}

export interface PushResult {
  kind: string;
  zoho_id: string;
  payload: Record<string, unknown>;
}

async function zohoPost(
  zohoFetch: typeof fetch, apiBase: string, orgId: string, token: string, path: string, body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await zohoFetch(`${apiBase}/${path}?organization_id=${encodeURIComponent(orgId)}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.code != null && j.code !== 0)) {
    throw new Error(`Zoho ${path} rejected: ${j.message ?? res.status}${j.code != null ? ` (code ${j.code})` : ""}`);
  }
  return j;
}

export async function pushLine(
  zohoFetch: typeof fetch, apiBase: string, orgId: string, token: string,
  line: ConfirmedLine, bankAccountId: string,
): Promise<PushResult> {
  const amount = Math.round(Number(line.amount) * 100) / 100;
  const common = {
    date: line.txn_date,
    reference_number: (line.reference ?? "").slice(0, 100) || undefined,
    description: line.description.slice(0, 500),
  };
  const kind = line.chosen_txn_kind;

  if (kind === "customer_payment") {
    if (!line.chosen_party_zoho_id) throw new Error("customer receipt needs a customer");
    if (line.side !== "credit") throw new Error("a customer receipt must be money IN");
    const body: Record<string, unknown> = {
      customer_id: line.chosen_party_zoho_id, payment_mode: "banktransfer", amount,
      account_id: bankAccountId, ...common,
    };
    if (line.chosen_doc_kind === "invoice" && line.chosen_doc_zoho_id) {
      body.invoices = [{ invoice_id: line.chosen_doc_zoho_id, amount_applied: amount }];
    }
    const j = await zohoPost(zohoFetch, apiBase, orgId, token, "customerpayments", body);
    const p = (j.payment ?? {}) as Record<string, unknown>;
    return { kind, zoho_id: String(p.payment_id ?? ""), payload: p };
  }

  if (kind === "vendor_payment") {
    if (!line.chosen_party_zoho_id) throw new Error("vendor payment needs a vendor");
    if (line.side !== "debit") throw new Error("a vendor payment must be money OUT");
    const body: Record<string, unknown> = {
      vendor_id: line.chosen_party_zoho_id, payment_mode: "banktransfer", amount,
      paid_through_account_id: bankAccountId, ...common,
    };
    if (line.chosen_doc_kind === "bill" && line.chosen_doc_zoho_id) {
      body.bills = [{ bill_id: line.chosen_doc_zoho_id, amount_applied: amount }];
    }
    const j = await zohoPost(zohoFetch, apiBase, orgId, token, "vendorpayments", body);
    const p = (j.vendorpayment ?? {}) as Record<string, unknown>;
    return { kind, zoho_id: String(p.payment_id ?? ""), payload: p };
  }

  if (kind === "expense") {
    // Same entry Zoho makes for a categorised "expense" bank line (credit
    // bank, debit the expense account), through the Expenses API — the
    // endpoint the bill/expense push already uses, so it is known to work
    // on this edition. The bank-transactions type list varies by edition
    // and account type; /expenses does not.
    if (!line.chosen_account_id) throw new Error("expense needs an account");
    if (line.side !== "debit") throw new Error("an expense must be money OUT");
    const body: Record<string, unknown> = {
      account_id: line.chosen_account_id, paid_through_account_id: bankAccountId, amount, ...common,
    };
    if (line.chosen_party_kind === "vendor" && line.chosen_party_zoho_id) body.vendor_id = line.chosen_party_zoho_id;
    const j = await zohoPost(zohoFetch, apiBase, orgId, token, "expenses", body);
    const e = (j.expense ?? {}) as Record<string, unknown>;
    return { kind, zoho_id: String(e.expense_id ?? ""), payload: e };
  }

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
    const j = await zohoPost(zohoFetch, apiBase, orgId, token, "banktransactions", body);
    const t = (j.banktransaction ?? {}) as Record<string, unknown>;
    return { kind, zoho_id: String(t.transaction_id ?? ""), payload: t };
  }

  throw new Error(`choose what this line is (customer receipt, vendor payment, expense, deposit or transfer) before posting`);
}
