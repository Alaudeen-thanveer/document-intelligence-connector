/**
 * Bank reconciliation nudge — pure.
 *
 * For each bank account at period end:
 *   statement closing balance (the last balance printed on the newest
 *   statement we hold for the period)  vs  Zoho book balance at the same
 *   date (the running balance of the last categorised bank transaction on
 *   or before the period end).
 * The difference is itemised into what the app can see: statement lines
 * not yet posted from here, and Zoho's uncategorised feed lines. Whatever
 * remains after that is "unexplained" and named as such.
 *
 * When the difference is zero and nothing is pending, we offer the Zoho
 * reconciliation as a proposal: POST /bankaccounts/{id}/reconciliations
 * {start_date, end_date, closing_balance, save_option: "reconcile",
 * transactions_to_be_reconciled: [ids]} — the body shape verified live;
 * Zoho refuses an end_date in the future (1043 Invalid Data).
 */

export interface ReconBankAccount { zoho_id: string; name: string; currency: string | null }
export interface ReconStatementLine {
  txn_date: string; line_no: number; side: "debit" | "credit"; amount: number; balance: number | null;
  status: string; // open | confirmed | posted | skipped | failed
  statement_id: string;
}
export interface ReconZohoTxn {
  transaction_id: string; date: string; status: string; // categorized | uncategorized | matched | manually_added | deleted
  debit_or_credit: string; amount: number; running_balance: number | null;
}
export interface ReconInput {
  account: ReconBankAccount;
  period_end: string; // yyyy-mm-dd
  period_start: string;
  today: string;
  lines: ReconStatementLine[]; // all local lines for this account
  zoho: ReconZohoTxn[];        // Zoho bank transactions for this account (all statuses, no date filter → running balances present)
  last_reconciled_end: string | null; // from GET /bankaccounts/{id}/reconciliations (latest completed end_date)
}
export interface ReconItem { label: string; amount: number; count: number; detail: string }
export interface ReconResult {
  account: ReconBankAccount;
  period_end: string;
  statement_closing: number | null;
  statement_closing_date: string | null;
  book_balance: number | null;
  book_balance_date: string | null;
  difference: number | null; // statement − book
  items: ReconItem[];        // explanations (signed as statement − book contributions)
  unexplained: number | null;
  unposted_lines: number;
  uncategorised_in_zoho: number;
  status: "no_statement" | "no_book" | "pending" | "differs" | "balanced";
  can_reconcile: boolean;
  reconcile_body: Record<string, unknown> | null;
  note: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const signed = (side: string, amt: number) => (side === "credit" ? amt : -amt); // statement credit = money in

/** Zoho speaks from the ledger: debit = money in. */
const zohoSigned = (t: ReconZohoTxn) => (t.debit_or_credit === "debit" ? t.amount : -t.amount);

export function reconcileAccount(input: ReconInput): ReconResult {
  const { account, period_end, period_start, today } = input;
  const base = { account, period_end, items: [] as ReconItem[] };

  // Statement side: newest line (by date, then line_no) on/before period end that carries a balance.
  const withBal = input.lines.filter((l) => l.balance != null && l.txn_date <= period_end).sort((a, b) => (a.txn_date === b.txn_date ? a.line_no - b.line_no : a.txn_date < b.txn_date ? -1 : 1));
  const lastBal = withBal.length ? withBal[withBal.length - 1] : null;
  const statementClosing = lastBal ? r2(Number(lastBal.balance)) : null;
  const statementDate = lastBal ? lastBal.txn_date : null;

  // Book side: last categorised Zoho transaction on/before period end with a running balance.
  const booked = input.zoho.filter((t) => t.status !== "uncategorized" && t.status !== "deleted" && t.date <= period_end && t.running_balance != null).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const lastBook = booked.length ? booked[booked.length - 1] : null;
  const bookBalance = lastBook ? r2(Number(lastBook.running_balance)) : (input.zoho.length === 0 ? null : 0);
  const bookDate = lastBook ? lastBook.date : null;

  // Pending on our side: statement lines on/before period end not posted/skipped.
  const unposted = input.lines.filter((l) => l.txn_date <= period_end && (l.status === "open" || l.status === "confirmed" || l.status === "failed"));
  const unpostedNet = r2(unposted.reduce((s, l) => s + signed(l.side, l.amount), 0));
  // Pending on Zoho's side: uncategorised feed lines on/before period end.
  // A movement that is BOTH an unposted local line and an uncategorised feed
  // line (same day, amount, direction) is one movement — count it once.
  const unpostedKeys = new Set(unposted.map((l) => `${l.txn_date}|${l.amount.toFixed(2)}|${l.side}`));
  const uncat = input.zoho.filter((t) => t.status === "uncategorized" && t.date <= period_end && !unpostedKeys.has(`${t.date}|${Number(t.amount).toFixed(2)}|${t.debit_or_credit === "debit" ? "credit" : "debit"}`));
  const uncatNet = r2(uncat.reduce((s, t) => s + zohoSigned(t), 0));

  const items: ReconItem[] = [];
  if (unposted.length) items.push({ label: "Statement lines not yet posted from here", amount: unpostedNet, count: unposted.length, detail: `${unposted.length} line${unposted.length === 1 ? "" : "s"} still open/confirmed on the Bank page — net ${unpostedNet.toFixed(2)} (money in positive)` });
  if (uncat.length) items.push({ label: "Uncategorised in Zoho's bank feed", amount: uncatNet, count: uncat.length, detail: `${uncat.length} feed line${uncat.length === 1 ? "" : "s"} Zoho has not categorised — net ${uncatNet.toFixed(2)}` });

  if (statementClosing == null) {
    return { ...base, statement_closing: null, statement_closing_date: null, book_balance: bookBalance, book_balance_date: bookDate, difference: null, items, unexplained: null, unposted_lines: unposted.length, uncategorised_in_zoho: uncat.length, status: "no_statement", can_reconcile: false, reconcile_body: null,
      note: `No statement balance on file for ${account.name} up to ${period_end} — upload the bank statement (with its balance column) to compare against the books.` };
  }
  if (bookBalance == null) {
    return { ...base, statement_closing: statementClosing, statement_closing_date: statementDate, book_balance: null, book_balance_date: null, difference: null, items, unexplained: null, unposted_lines: unposted.length, uncategorised_in_zoho: uncat.length, status: "no_book", can_reconcile: false, reconcile_body: null,
      note: `Zoho has no transactions for ${account.name} — nothing to reconcile against yet.` };
  }
  const difference = r2(statementClosing - bookBalance);
  // Unposted lines explain statement − book in the statement's favour; uncategorised Zoho lines (already in the feed, not in books) likewise.
  const explained = r2(unpostedNet + uncatNet);
  const unexplained = r2(difference - explained);
  if (Math.abs(unexplained) > 0.005) items.push({ label: "Unexplained", amount: unexplained, count: 0, detail: `Remains after the pending lines above — a bank charge or a posting not on this statement? Look at Zoho's bank transactions for ${account.name} around ${period_end}.` });

  const pending = unposted.length + uncat.length > 0;
  const balanced = Math.abs(difference) <= 0.005 && !pending;
  const endForZoho = period_end <= today ? period_end : today;
  const txnIds = input.zoho.filter((t) => t.status !== "uncategorized" && t.status !== "deleted" && t.date >= (input.last_reconciled_end ? nextDay(input.last_reconciled_end) : "0000-00-00") && t.date <= endForZoho).map((t) => t.transaction_id);
  const canReconcile = balanced && period_end <= today && txnIds.length > 0;
  const startForZoho = input.last_reconciled_end ? nextDay(input.last_reconciled_end) : period_start;
  const body = canReconcile ? { start_date: startForZoho, end_date: endForZoho, closing_balance: statementClosing, save_option: "reconcile", transactions_to_be_reconciled: txnIds } : null;

  let status: ReconResult["status"]; let note: string;
  if (balanced) { status = "balanced"; note = period_end <= today ? `Statement and books agree at ${statementClosing.toFixed(2)} on ${period_end}, nothing pending — reconcile in Zoho with one click.` : `Statement and books agree at ${statementClosing.toFixed(2)}; Zoho will accept the reconciliation once ${period_end} has passed.`; }
  else if (Math.abs(difference) <= 0.005) { status = "pending"; note = `Balances agree at ${statementClosing.toFixed(2)} but ${unposted.length + uncat.length} line${unposted.length + uncat.length === 1 ? " is" : "s are"} still pending — finish those, then reconcile.`; }
  else { status = Math.abs(unexplained) <= 0.005 ? "pending" : "differs"; note = `Statement ${statementClosing.toFixed(2)} (${statementDate}) vs books ${bookBalance.toFixed(2)} (${bookDate}) — difference ${difference.toFixed(2)}${Math.abs(unexplained) <= 0.005 ? ", fully explained by the pending lines" : `, of which ${unexplained.toFixed(2)} is unexplained`}.`; }

  return { ...base, statement_closing: statementClosing, statement_closing_date: statementDate, book_balance: bookBalance, book_balance_date: bookDate, difference, items, unexplained, unposted_lines: unposted.length, uncategorised_in_zoho: uncat.length, status, can_reconcile: canReconcile, reconcile_body: body, note };
}

function nextDay(d: string): string {
  const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10);
}
