/**
 * Bank transactions from Zoho (bank layer 1): which kind a Zoho
 * transaction_type is, caching categorised transactions per bank account,
 * and turning cached history into the observations bank patterns learn from.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ZohoAuth } from "../_shared/zoho_auth.ts";
import type { BankObservation, BankSide, BankTxnKind } from "./bank_patterns.ts";
import { zohoGet } from "./zoho_history.ts";

// ---------------------------------------------------------------------------
// Bank transactions (bank layer 1).
// ---------------------------------------------------------------------------

/** Zoho transaction_type → the kind we learn. */
function bankTxnKind(t: string): BankTxnKind {
  const s = t.toLowerCase();
  if (s === "customer_payment") return "customer_payment";
  if (s === "vendor_payment") return "vendor_payment";
  if (s.includes("transfer")) return "transfer";
  if (
    s === "expense" || s === "card_payment" || s === "expense_refund" ||
    s.includes("charge") || s.includes("tax")
  ) return "expense";
  if (
    s === "deposit" || s === "sales_without_invoices" || s === "interest_income" ||
    s === "other_income" || s === "owner_contribution" || s === "refund"
  ) return "deposit";
  return "other";
}

/**
 * List categorised transactions on every bank/cash account and cache the
 * rows. Zoho keeps payment-type rows under the payments endpoints (their
 * detail 404s here), so only expense/deposit/transfer kinds are detail-
 * fetched, and only to learn the category account id.
 */
export async function fetchBankTransactions(
  supabase: SupabaseClient,
  z: ZohoAuth,
  companyId: string,
  fromDate: string,
  cap: number,
): Promise<number> {
  const accts = await zohoGet(z, "bankaccounts");
  const accounts = ((accts.bankaccounts as Array<Record<string, unknown>>) ?? [])
    .filter((a) => a.account_id != null);
  let fetched = 0;
  for (const a of accounts) {
    const accountId = String(a.account_id);
    let page = 1;
    let count = 0;
    while (count < cap && page <= 25) {
      let raw: Record<string, unknown>;
      try {
        raw = await zohoGet(z, "banktransactions", {
          account_id: accountId,
          date_start: fromDate,
          per_page: "200",
          page: String(page),
          sort_column: "date",
          sort_order: "D",
        });
      } catch {
        // Some orgs reject the date filter here; fall back to unfiltered.
        raw = await zohoGet(z, "banktransactions", {
          account_id: accountId,
          per_page: "200",
          page: String(page),
        });
      }
      const rows = (raw.banktransactions as Array<Record<string, unknown>>) ?? [];
      for (const row of rows) {
        const id = String(row.transaction_id ?? "");
        if (!id) continue;
        // Uncategorised feed lines teach nothing yet.
        const status = String(row.status ?? "").toLowerCase();
        if (status === "uncategorized") continue;
        const { data: have } = await supabase
          .from("bk_history_raw")
          .select("zoho_id")
          .eq("company_id", companyId)
          .eq("doc_kind", "banktransaction")
          .eq("zoho_id", id)
          .maybeSingle();
        if (have) { count++; continue; }

        const kind = bankTxnKind(String(row.transaction_type ?? ""));
        let payload: Record<string, unknown> = { banktransaction: row };
        if (kind !== "customer_payment" && kind !== "vendor_payment") {
          try {
            const detail = await zohoGet(z, `banktransactions/${id}`);
            if (detail.banktransaction) {
              payload = {
                banktransaction: {
                  ...row,
                  ...(detail.banktransaction as Record<string, unknown>),
                },
              };
            }
          } catch {
            // list row is enough; category id resolves by name later
          }
        }
        await supabase.from("bk_history_raw").upsert({
          company_id: companyId,
          doc_kind: "banktransaction",
          zoho_id: id,
          payload,
        }, { onConflict: "company_id,doc_kind,zoho_id" });
        fetched++;
        count++;
        if (count >= cap) break;
      }
      const more = Boolean(
        (raw as { page_context?: { has_more_page?: boolean } }).page_context
          ?.has_more_page,
      );
      if (!more) break;
      page++;
    }
  }
  return fetched;
}

/**
 * Turn cached history into bank observations. Three sources:
 *   • categorised bank transactions (description, payee, category account)
 *   • customer / vendor payments (description + reference, party, deposit
 *     or paid-through account)
 *   • lines a reviewer confirmed in this app (added in bank layer 4)
 * accountByName resolves a category shown only by name on list rows.
 */
export function bankObservationsFromHistory(
  rawRows: Array<{ doc_kind: string; payload: unknown }>,
  accountByName: Map<string, string>,
): BankObservation[] {
  const out: BankObservation[] = [];
  for (const r of rawRows) {
    const p = r.payload as Record<string, unknown>;
    if (r.doc_kind === "banktransaction") {
      const t = (p.banktransaction ?? p) as Record<string, unknown>;
      // First non-empty of description / reference / payee — feeds often
      // leave description blank and put the counterparty in payee.
      const description = [t.description, t.reference_number, t.payee]
        .map((x) => (x == null ? "" : String(x).trim()))
        .find(Boolean) ?? "";
      if (!description) continue;
      // Zoho's debit_or_credit is the LEDGER view (money out of the bank =
      // credit to the bank account); our side is the statement view.
      const side: BankSide = String(t.debit_or_credit ?? "").toLowerCase() === "credit"
        ? "debit"
        : "credit";
      const kind = bankTxnKind(String(t.transaction_type ?? ""));
      const isPayment = kind === "customer_payment" || kind === "vendor_payment";
      // Category account: from detail line_items, else by offset name.
      const li = ((t.line_items as Array<Record<string, unknown>>) ?? [])[0];
      const offsetName = t.offset_account_name != null ? String(t.offset_account_name) : null;
      const accountId = li?.account_id != null
        ? String(li.account_id)
        : offsetName && accountByName.has(offsetName.toLowerCase())
        ? accountByName.get(offsetName.toLowerCase())!
        : null;
      const partyId = t.customer_id != null && String(t.customer_id) !== ""
        ? String(t.customer_id)
        : t.vendor_id != null && String(t.vendor_id) !== ""
        ? String(t.vendor_id)
        : null;
      out.push({
        description,
        side,
        amount: Number(t.amount ?? 0) || 0,
        date: String(t.date ?? "").slice(0, 10),
        txn_kind: kind,
        party_kind: partyId
          ? (kind === "vendor_payment" || (kind === "expense" && side === "debit") ? "vendor" : "customer")
          : null,
        party_zoho_id: partyId,
        party_name: t.payee != null && String(t.payee) !== "" ? String(t.payee) : null,
        account_id: isPayment ? null : accountId,
        account_name: isPayment ? null : (li?.account_name != null ? String(li.account_name) : offsetName),
        source: "zoho_bank",
      });
    } else if (r.doc_kind === "customerpayment" || r.doc_kind === "vendorpayment") {
      const root = r.doc_kind === "customerpayment" ? "payment" : "vendorpayment";
      const d = (p[root] ?? p) as Record<string, unknown>;
      const description = [d.description, d.reference_number]
        .map((x) => (x == null ? "" : String(x).trim()))
        .filter(Boolean)
        .join(" ");
      if (!description) continue;
      const isCustomer = r.doc_kind === "customerpayment";
      out.push({
        description,
        side: isCustomer ? "credit" : "debit",
        amount: Number(d.amount ?? 0) || 0,
        date: String(d.date ?? "").slice(0, 10),
        txn_kind: isCustomer ? "customer_payment" : "vendor_payment",
        party_kind: isCustomer ? "customer" : "vendor",
        party_zoho_id: String((isCustomer ? d.customer_id : d.vendor_id) ?? "") || null,
        party_name: String((isCustomer ? d.customer_name : d.vendor_name) ?? "") || null,
        account_id: null,
        account_name: null,
        source: "zoho_payment",
      });
    }
  }
  return out;
}
