/**
 * Seed a DEMO dataset for the screen recording.
 *
 * Writes synthetic Zoho-shaped history into bk_history_raw and demo parties
 * into the local zoho_entities cache. No Zoho calls, nothing written to the
 * real org. The learner then runs for real over this history, so every
 * profile / proposal shown in the app is genuinely computed by the shipped
 * code — only the underlying history is invented.
 *
 * Re-runnable: clears its own demo rows first.
 */
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  env[t.slice(0, i)] = t.slice(i + 1).trim();
}
const URL_ = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json" };
const COMPANY = "00000000-0000-4000-8000-000000000001";

const ACC = {
  cargo: ["13654000000007059", "Cargo Expense Account"],
  consult: ["13654000000000460", "Consultant Expense"],
  office: ["13654000000000406", "Office Supplies"],
  rent: ["13654000000000436", "Rent Expense"],
  sales: ["13654000000000394", "Sales"],
  phone: ["13654000000000427", "Telephone Expense"],
  travel: ["13654000000000424", "Travel Expense"],
};

async function del(table, query) {
  const r = await fetch(`${URL_}/rest/v1/${table}?${query}`, { method: "DELETE", headers: H });
  if (!r.ok && r.status !== 404) console.warn(`delete ${table}: ${r.status} ${(await r.text()).slice(0, 120)}`);
}
async function ins(table, rows, opts = "") {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const r = await fetch(`${URL_}/rest/v1/${table}${opts}`, {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal,resolution=merge-duplicates" },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) throw new Error(`insert ${table} failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}
// months ago from Aug 2026
function d(monthsAgo, day) {
  const dt = new Date(Date.UTC(2026, 7, day));
  dt.setUTCMonth(dt.getUTCMonth() - monthsAgo);
  return dt.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- parties
const VENDORS = [
  ["demo-v-landlord", "Landlord Properties LLC"],
  ["demo-v-etisalat", "Etisalat Business"],
  ["demo-v-falcon", "Falcon Freight LLC"],
  ["demo-v-gulfcon", "Gulf Consulting Partners"],
  ["demo-v-mixed", "Mixed Traders LLC"],
  ["demo-v-desert", "Desert Stationery"],
];
const CUSTOMERS = [["demo-c-acme", "Acme Retail Group"]];

// ---------------------------------------------------------------- history
const bills = [];
const invoices = [];
const journals = [];
const payments = [];
let seq = 0;

function bill({ vid, vname, date, total, acct, attachments = 1, terms = 30, status = "paid", balance = 0, extraLines = [], tags = [] }) {
  const id = `demo-b-${++seq}`;
  const [aid, aname] = acct;
  const net = Math.round((total / 1.05) * 100) / 100;
  bills.push({
    company_id: COMPANY, doc_kind: "bill", zoho_id: id,
    payload: {
      bill: {
        bill_id: id, bill_number: `${vname.split(" ")[0].toUpperCase()}-${1000 + seq}`,
        vendor_id: vid, vendor_name: vname,
        date, due_date: addDays(date, terms), created_time: `${addDays(date, 2)}T09:00:00+0400`,
        total, balance, status, currency_code: "AED", tax_treatment: "vat_registered",
        payment_terms: terms,
        line_items: [
          { account_id: aid, account_name: aname, item_total: net, quantity: 1, rate: net, tags, project_id: "", project_name: "" },
          ...extraLines,
        ],
        documents: Array.from({ length: attachments }, (_, i) => ({
          file_name: i === 0 ? `invoice-${1000 + seq}.pdf` : `delivery-note-${1000 + seq}.pdf`,
          file_type: "pdf",
        })),
      },
    },
  });
  return id;
}

// 1. Landlord — 24 months, day 1, ALWAYS 4200 → fixed_recurring + anomaly check
for (let m = 23; m >= 0; m--) {
  const date = d(m, 1);
  const id = bill({ vid: "demo-v-landlord", vname: "Landlord Properties LLC", date, total: 4200, acct: ACC.rent, attachments: 1, terms: 0 });
  // paid fast: 2 days
  payments.push({
    company_id: COMPANY, doc_kind: "vendorpayment", zoho_id: `demo-p-l${m}`,
    payload: { vendorpayment: { payment_id: `demo-p-l${m}`, vendor_id: "demo-v-landlord", date: addDays(date, 2), amount: 4200, payment_mode: "banktransfer", paid_through_account_id: "demo-bank", paid_through_account_name: "Emirates NBD Current", bills: [{ bill_id: id, amount_applied: 4200 }] } },
  });
}
// 2. Etisalat — 24 months, day 2-4, varying 900-1500 → variable_recurring + expected_missing
//    paid SLOWLY (40 days vs 30-day terms) → timing profile shows "pays 10 days late"
for (let m = 23; m >= 0; m--) {
  const date = d(m, 2 + (m % 3));
  const total = 900 + ((m * 137) % 600);
  const id = bill({ vid: "demo-v-etisalat", vname: "Etisalat Business", date, total, acct: ACC.phone, attachments: 1, terms: 30 });
  payments.push({
    company_id: COMPANY, doc_kind: "vendorpayment", zoho_id: `demo-p-e${m}`,
    payload: { vendorpayment: { payment_id: `demo-p-e${m}`, vendor_id: "demo-v-etisalat", date: addDays(date, 40), amount: total, payment_mode: "banktransfer", paid_through_account_id: "demo-bank", paid_through_account_name: "Emirates NBD Current", bills: [{ bill_id: id, amount_applied: total }] } },
  });
}
// 3. Falcon — 18 bills, Cargo (16) / Consultant (2), ALWAYS 2 attachments → strict attachment convention
for (let m = 17; m >= 0; m--) {
  bill({
    vid: "demo-v-falcon", vname: "Falcon Freight LLC", date: d(m, 10 + (m % 5)),
    total: 380 + ((m * 53) % 90), acct: m % 9 === 3 ? ACC.consult : ACC.cargo, attachments: 2, terms: 15,
  });
}
// 4. Gulf Consulting — 14 bills, irregular months, always Consultant → dominant account, irregular cadence
for (const m of [0, 1, 3, 4, 4, 7, 8, 11, 12, 12, 15, 18, 20, 22]) {
  bill({ vid: "demo-v-gulfcon", vname: "Gulf Consulting Partners", date: d(m, 6 + (m % 12)), total: 2500 + ((m * 311) % 4000), acct: ACC.consult, attachments: 1, terms: 30 });
}
// 5. Mixed Traders — 12 bills, each with BOTH accounts → split party (cannot accept one rule)
for (let m = 11; m >= 0; m--) {
  const date = d(m, 20);
  const [cid, cname] = ACC.cargo;
  bill({
    vid: "demo-v-mixed", vname: "Mixed Traders LLC", date, total: 1000, acct: ACC.consult, attachments: 1, terms: 30,
    extraLines: [{ account_id: cid, account_name: cname, item_total: 476.19, quantity: 1, rate: 476.19, tags: [], project_id: "", project_name: "" }],
  });
}
// 6. Desert Stationery — only 2 bills → below the 3-doc gate, NOT proposable
for (let m of [1, 5]) {
  bill({ vid: "demo-v-desert", vname: "Desert Stationery", date: d(m, 12), total: 240, acct: ACC.office, attachments: 0, terms: 30 });
}
// 7. Acme Retail — 10 invoices → customer profile
for (let m = 9; m >= 0; m--) {
  const date = d(m, 15);
  const id = `demo-i-${m}`;
  const [aid, aname] = ACC.sales;
  invoices.push({
    company_id: COMPANY, doc_kind: "invoice", zoho_id: id,
    payload: {
      invoice: {
        invoice_id: id, invoice_number: `INV-${2000 + m}`, customer_id: "demo-c-acme", customer_name: "Acme Retail Group",
        date, due_date: addDays(date, 15), created_time: `${addDays(date, 1)}T10:00:00+0400`,
        total: 5000, balance: 0, status: "paid", currency_code: "AED", tax_treatment: "vat_registered", payment_terms: 15,
        line_items: [{ account_id: aid, account_name: aname, item_total: 4761.9, quantity: 1, rate: 4761.9, tags: [], project_id: "", project_name: "" }],
        documents: [],
      },
    },
  });
  payments.push({
    company_id: COMPANY, doc_kind: "customerpayment", zoho_id: `demo-p-c${m}`,
    payload: { payment: { payment_id: `demo-p-c${m}`, customer_id: "demo-c-acme", date: addDays(date, 12), amount: 5000, payment_mode: "banktransfer", account_id: "demo-bank", account_name: "Emirates NBD Current", invoices: [{ invoice_id: id, amount_applied: 5000 }] } },
  });
}
// 8. Manual accrual journal, month-end, 12 months → undeclared recurring journal pattern
for (let m = 11; m >= 0; m--) {
  const dt = new Date(Date.UTC(2026, 8 - m, 0)); // last day of that month
  const date = dt.toISOString().slice(0, 10);
  const id = `demo-j-${m}`;
  journals.push({
    company_id: COMPANY, doc_kind: "journal", zoho_id: id,
    payload: {
      journal: {
        journal_id: id, journal_date: date, reference_number: `ACC-${date.slice(0, 7)}`,
        notes: `Consultant accrual ${date.slice(0, 7)}`, total: 900, status: "published",
        line_items: [
          { account_id: ACC.consult[0], account_name: ACC.consult[1], amount: 900, debit_or_credit: "debit", tags: [] },
          { account_id: ACC.travel[0], account_name: ACC.travel[1], amount: 900, debit_or_credit: "credit", tags: [] },
        ],
      },
    },
  });
}

// 9. Bank transactions — categorised statement lines, Zoho-shaped, so bank
//    layer 1 has descriptions to fingerprint. Money out = debit, in = credit.
const bank = [];
function bt({ id, date, amount, side, type, payee = "", customer_id = "", description, offset, account_id }) {
  bank.push({
    company_id: COMPANY, doc_kind: "banktransaction", zoho_id: id,
    payload: {
      banktransaction: {
        transaction_id: id, date, amount, transaction_type: type, status: "categorized",
        account_id: "demo-bank", account_name: "Emirates NBD Current",
        debit_or_credit: side, payee, customer_id, description, reference_number: "",
        offset_account_name: offset ?? "", currency_code: "AED",
        ...(account_id ? { line_items: [{ account_id, account_name: offset, amount }] } : {}),
      },
    },
  });
}
// Etisalat POS every month → Telephone Expense (expense, vendor)
for (let m = 11; m >= 0; m--) bt({ id: `demo-bt-e${m}`, date: d(m, 5), amount: 900 + ((m * 137) % 600), side: "debit", type: "expense", payee: "Etisalat Business", customer_id: "demo-v-etisalat", description: `POS PURCHASE ETISALAT ${44000 + m} DUBAI AE`, offset: ACC.phone[1], account_id: ACC.phone[0] });
// Acme inward remittances → customer payments (party only, no category account)
for (let m = 9; m >= 0; m--) bt({ id: `demo-bt-a${m}`, date: addDays(d(m, 15), 12), amount: 5000, side: "credit", type: "customer_payment", payee: "Acme Retail Group", customer_id: "demo-c-acme", description: `INWARD TT ACME RETAIL GRP REF ${88000 + m} VALUE DATE ${d(m, 27).replace(/-/g, "")}` });
// Bank charges → Bank Fees and Charges, no party
for (let m = 11; m >= 0; m--) bt({ id: `demo-bt-f${m}`, date: d(m, 1), amount: 52.5, side: "debit", type: "expense", description: m % 2 ? "MONTHLY ACCOUNT MAINTENANCE FEE" : `ACCOUNT MAINTENANCE CHARGES ${m}`, offset: "Bank Fees and Charges", account_id: "13654000000000415" });
// Landlord standing order → vendor payment
for (let m = 11; m >= 0; m--) bt({ id: `demo-bt-l${m}`, date: addDays(d(m, 1), 2), amount: 4200, side: "debit", type: "vendor_payment", payee: "Landlord Properties LLC", customer_id: "demo-v-landlord", description: `SO TRF LANDLORD PROPERTIES LLC RENT ${d(m, 1).slice(0, 7)}` });
// Salary WPS batch — split habit: 3× Salaries, 3× Uncategorized (share 0.5 → below the gate)
for (let m = 5; m >= 0; m--) bt({ id: `demo-bt-s${m}`, date: d(m, 28), amount: 48000, side: "debit", type: "expense", description: `WPS SALARY BATCH ${1000 + m}`, offset: m % 2 ? "Salaries and Employee Wages" : "Uncategorized", account_id: m % 2 ? "13654000000000451" : "13654000000000499" });
// One-off — singleton, must not become a pattern
bt({ id: "demo-bt-x1", date: d(2, 9), amount: 1875, side: "debit", type: "expense", description: "AMAZON WEB SERVICES EMEA 5512", offset: "IT and Internet Expenses", account_id: "13654000000000433" });

// ---------------------------------------------------------------- write
console.log("clearing previous demo rows…");
await del("bk_history_raw", `company_id=eq.${COMPANY}&zoho_id=like.demo-*`);
await del("zoho_entities", "zoho_id=like.demo-*");

console.log(`inserting parties (${VENDORS.length} vendors, ${CUSTOMERS.length} customers)…`);
await ins("zoho_entities", [
  ...VENDORS.map(([zoho_id, name]) => ({ kind: "vendor", zoho_id, name, extra: { status: "active", tax_treatment: "vat_registered" } })),
  ...CUSTOMERS.map(([zoho_id, name]) => ({ kind: "customer", zoho_id, name, extra: { status: "active", tax_treatment: "vat_registered" } })),
  { kind: "bank_account", zoho_id: "demo-bank", name: "Emirates NBD Current", extra: { account_type: "bank" } },
]);

const all = [...bills, ...invoices, ...journals, ...payments, ...bank];
console.log(`inserting history: ${bills.length} bills, ${invoices.length} invoices, ${journals.length} journals, ${payments.length} payments, ${bank.length} bank transactions…`);
await ins("bk_history_raw", all);

console.log("done. Now run the learner with reanalyze_only to compute real profiles.");
