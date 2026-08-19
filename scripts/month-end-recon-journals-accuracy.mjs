/**
 * Month-end reconciliation + journal proposals accuracy check (pure modules).
 * Usage: node --experimental-strip-types scripts/month-end-recon-journals-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { reconcileAccount } = await import(pathToFileURL(resolve(root, "supabase/functions/month-end/reconciliation.ts")).href);
const { buildJournalProposal, journalBody, spread, proposalDate } = await import(pathToFileURL(resolve(root, "supabase/functions/month-end/journal_proposals.ts")).href);
let failures = 0;
function check(name, cond, detail = "") { const ok = Boolean(cond); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; }

console.log("— reconciliation —");
const acct = { zoho_id: "B1", name: "T1 Test Bank", currency: "AED" };
const base = { account: acct, period_start: "2026-08-01", period_end: "2026-08-31", today: "2026-09-03", last_reconciled_end: null };
// Statement: +1000 in, −300 out, −50 charge → closing 650.
const lines = [
  { statement_id: "s1", txn_date: "2026-08-05", line_no: 1, side: "credit", amount: 1000, balance: 1000, status: "posted" },
  { statement_id: "s1", txn_date: "2026-08-10", line_no: 2, side: "debit", amount: 300, balance: 700, status: "posted" },
  { statement_id: "s1", txn_date: "2026-08-28", line_no: 3, side: "debit", amount: 50, balance: 650, status: "posted" },
];
// Zoho books (ledger view: debit = money in), running balance newest first.
const zoho = [
  { transaction_id: "z3", date: "2026-08-28", status: "categorized", debit_or_credit: "credit", amount: 50, running_balance: 650 },
  { transaction_id: "z2", date: "2026-08-10", status: "categorized", debit_or_credit: "credit", amount: 300, running_balance: 700 },
  { transaction_id: "z1", date: "2026-08-05", status: "categorized", debit_or_credit: "debit", amount: 1000, running_balance: 1000 },
];
let r = reconcileAccount({ ...base, lines, zoho });
check("balanced: statement 650 = books 650, nothing pending", r.status === "balanced" && r.difference === 0 && r.can_reconcile, r.note);
check("reconcile body: period dates, closing, reconcile mode, all 3 booked ids", r.reconcile_body.start_date === "2026-08-01" && r.reconcile_body.end_date === "2026-08-31" && r.reconcile_body.closing_balance === 650 && r.reconcile_body.save_option === "reconcile" && r.reconcile_body.transactions_to_be_reconciled.length === 3, JSON.stringify(r.reconcile_body));
r = reconcileAccount({ ...base, today: "2026-08-20", lines, zoho });
check("period end in the future: balanced but Zoho would refuse → no body yet", r.status === "balanced" && !r.can_reconcile && /once 2026-08-31 has passed/.test(r.note), r.note);
r = reconcileAccount({ ...base, last_reconciled_end: "2026-07-31", lines, zoho });
check("after a July reconciliation the next starts 2026-08-01", r.reconcile_body.start_date === "2026-08-01");
// Statement has an unposted charge line: statement 650, books 700 (charge not in books yet).
r = reconcileAccount({ ...base, lines: lines.map((l) => l.line_no === 3 ? { ...l, status: "open" } : l), zoho: zoho.slice(1) });
check("unposted statement line explains the whole difference", r.status === "pending" && r.difference === -50 && r.items[0].count === 1 && r.items[0].amount === -50 && r.unexplained === 0, r.note);
check("not reconcilable while pending", !r.can_reconcile);
// Zoho uncategorised feed line (money in 200) not on our statement side: statement 650, books 650 but uncat pending → pending
r = reconcileAccount({ ...base, lines, zoho: [{ transaction_id: "u1", date: "2026-08-30", status: "uncategorized", debit_or_credit: "debit", amount: 200, running_balance: null }, ...zoho] });
check("uncategorised Zoho line → pending, counted, not in book balance", r.status === "pending" && r.uncategorised_in_zoho === 1 && r.book_balance === 650, r.note);
// Same movement in both: our open line (+200 credit 08-30) and Zoho uncat (+200 debit 08-30) → one item, not two
r = reconcileAccount({ ...base, lines: [...lines, { statement_id: "s1", txn_date: "2026-08-30", line_no: 4, side: "credit", amount: 200, balance: 850, status: "open" }], zoho: [{ transaction_id: "u1", date: "2026-08-30", status: "uncategorized", debit_or_credit: "debit", amount: 200, running_balance: null }, ...zoho] });
check("same movement in both modes counted once: difference 200 fully explained", r.difference === 200 && r.unexplained === 0 && r.items.length === 1 && r.uncategorised_in_zoho === 0, JSON.stringify(r.items));
// Unexplained: statement 650 vs books 700 with nothing pending.
r = reconcileAccount({ ...base, lines, zoho: zoho.slice(1) });
check("difference with nothing pending is named unexplained", r.status === "differs" && r.unexplained === -50 && r.items.some((i) => i.label === "Unexplained"), r.note);
r = reconcileAccount({ ...base, lines: lines.map((l) => ({ ...l, balance: null })), zoho });
check("no balance column on statement → no_statement", r.status === "no_statement" && !r.can_reconcile);
r = reconcileAccount({ ...base, lines, zoho: [] });
check("nothing in Zoho → no_book", r.status === "no_book");
// Future-dated Zoho txns beyond period end ignored for book balance
r = reconcileAccount({ ...base, lines, zoho: [{ transaction_id: "z9", date: "2026-09-02", status: "categorized", debit_or_credit: "debit", amount: 99, running_balance: 749 }, ...zoho] });
check("transactions after period end do not move the period-end book balance", r.book_balance === 650 && r.status === "balanced" && !r.reconcile_body.transactions_to_be_reconciled.includes("z9"));

console.log("\n— journal proposals —");
check("spread 100 over 3 = 33.34/33.33/33.33", JSON.stringify(spread(100, 3)) === "[33.34,33.33,33.33]");
const pattern = { id: "p1", fingerprint: "A1:D+A2:C", label: "Depreciation — office equipment", accounts: [{ account_id: "A1", account_name: "Depreciation expense", side: "D" }, { account_id: "A2", account_name: "Accumulated depreciation", side: "C" }], amount_median: 1250, expected_day_min: 28, expected_day_max: 31 };
let j = buildJournalProposal(pattern, "2026-02", "2026-03-05");
check("date = usual day clamped to the month (Feb 28)", j.journal_date === "2026-02-28", j.journal_date);
check("lines: debit and credit at the median", j.lines.length === 2 && j.lines[0].side === "D" && j.lines[0].amount === 1250 && j.lines[1].side === "C" && j.lines[1].amount === 1250 && j.total === 1250 && !j.needs_amount);
check("notes say why", /posted by hand every month around day 28–31, usually ~1250\.00/.test(j.notes), j.notes);
check("reference is stable per period and distinct per pattern", /^DIC-JNL-2026-02-[0-9A-F]{6}$/.test(j.reference_number) && j.reference_number === buildJournalProposal(pattern, "2026-02", "2026-03-05").reference_number && j.reference_number !== buildJournalProposal({ ...pattern, fingerprint: "A1:D+A9:C" }, "2026-02", "2026-03-05").reference_number, j.reference_number);
j = buildJournalProposal(pattern, "2026-08", "2026-08-19");
check("current month: not dated in the future", j.journal_date === "2026-08-19", j.journal_date);
j = buildJournalProposal({ ...pattern, amount_median: null }, "2026-08", "2026-08-19");
check("no median: structure proposed, amount to be filled", j.needs_amount && j.total === 0 && j.lines.every((l) => l.amount === 0));
check("one-sided pattern is not a postable shape", buildJournalProposal({ ...pattern, accounts: pattern.accounts.slice(0, 1) }, "2026-08", "2026-08-19") === null);
j = buildJournalProposal({ ...pattern, accounts: [...pattern.accounts, { account_id: "A3", account_name: "Accum dep — vehicles", side: "C" }] }, "2026-08", "2026-08-19");
check("two credits split the median, cents to the first", j.lines[1].amount === 625 && j.lines[2].amount === 625 && j.lines[0].amount === 1250);

let b = journalBody({ journal_date: "2026-08-31", reference_number: "R1", notes: "n", lines: [{ account_id: "A1", account_name: null, side: "D", amount: 1250, description: "Dep" }, { account_id: "A2", account_name: null, side: "C", amount: 1250, description: "Dep" }] });
check("Zoho body: line_items with debit_or_credit and amounts", b.ok && b.body.line_items.length === 2 && b.body.line_items[0].debit_or_credit === "debit" && b.body.line_items[1].debit_or_credit === "credit" && b.body.journal_date === "2026-08-31" && b.total === 1250, JSON.stringify(b));
b = journalBody({ journal_date: "2026-08-31", reference_number: null, notes: null, lines: [{ account_id: "A1", side: "D", amount: 1250 }, { account_id: "A2", side: "C", amount: 1200 }] });
check("unbalanced edit refused", !b.ok && /do not balance/.test(b.error), b.error);
b = journalBody({ journal_date: "2026-08-31", reference_number: null, notes: null, lines: [{ account_id: "A1", side: "D", amount: 0 }, { account_id: "A2", side: "C", amount: 0 }] });
check("zero amounts refused (reviewer must fill)", !b.ok && /above zero/.test(b.error), b.error);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
