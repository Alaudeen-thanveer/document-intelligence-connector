/**
 * Seed DEMO documents for the recording: a couple that need a decision and
 * several already settled, so the Documents list and review panel have
 * something real to show. Judgment is then run for real on the ones under
 * review, so the checks shown are genuinely computed.
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
const U = env.SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { Authorization: `Bearer ${K}`, apikey: K, "Content-Type": "application/json" };
const FILE = `${U}/storage/v1/object/public/invoices/push-check.pdf`;

async function post(table, rows, prefer = "return=representation,resolution=merge-duplicates") {
  const r = await fetch(`${U}/rest/v1/${table}`, { method: "POST", headers: { ...H, Prefer: prefer }, body: JSON.stringify(rows) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${table}: ${r.status} ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : [];
}
async function del(table, q) {
  await fetch(`${U}/rest/v1/${table}?${q}`, { method: "DELETE", headers: H });
}

const DOCS = [
  // --- wants a look: unusually large Etisalat bill, and no supporting document
  // Lines must reconcile: 2400.00 + (14 x 74.40) = 3441.60 net, 5% VAT = 172.08,
  // total 3613.68. The review screen checks this sum and says so when it fails.
  { id: "dd000001-0000-4000-8000-000000000001", src: "email:ap@accintel.test", status: "needs_review", has_doc: false,
    vendor: "Etisalat Business", total: 3613.68, date: "2026-08-12", num: "ETI-88213", vat: 172.08, due: "2026-09-11",
    lines: [["Enterprise fibre — Aug", 1, 2400], ["Additional lines (14)", 14, 74.4]] },
  // --- wants a look: vendor that does not exist in Zoho Books
  { id: "dd000002-0000-4000-8000-000000000002", src: "email:ap@accintel.test", status: "needs_review", has_doc: true,
    vendor: "Al Noor Trading LLC", total: 2100, date: "2026-08-14", num: "AN-0091", vat: 100, due: "2026-09-13",
    lines: [["Pallet racking", 1, 2000]] },
  // --- settled
  { id: "dd000003-0000-4000-8000-000000000003", src: "email:ap@accintel.test", status: "synced", has_doc: true,
    vendor: "Landlord Properties LLC", total: 4200, date: "2026-08-01", num: "LAND-1024", vat: 200, due: "2026-08-01",
    lines: [["Office rent — August", 1, 4000]] },
  { id: "dd000004-0000-4000-8000-000000000004", src: "email:ap@accintel.test", status: "synced", has_doc: true,
    vendor: "Falcon Freight LLC", total: 441, date: "2026-08-09", num: "FAL-2210", vat: 21, due: "2026-08-24",
    lines: [["Sea freight", 1, 300], ["Container handling", 2, 60]] },
  { id: "dd000005-0000-4000-8000-000000000005", src: "upload", status: "synced", has_doc: true,
    vendor: "Gulf Consulting Partners", total: 5250, date: "2026-08-06", num: "GCP-771", vat: 250, due: "2026-09-05",
    lines: [["Advisory retainer — Aug", 1, 5000]] },
  { id: "dd000006-0000-4000-8000-000000000006", src: "email:ap@accintel.test", status: "synced", has_doc: true,
    vendor: "Mixed Traders LLC", total: 1000, date: "2026-08-05", num: "MIX-330", vat: 47.62, due: "2026-09-04",
    lines: [["Consulting", 1, 476.19], ["Freight", 1, 476.19]] },
];

console.log("clearing previous demo documents…");
for (const d of DOCS) await del("documents", `id=eq.${d.id}`);

console.log("inserting documents…");
await post("documents", DOCS.map((d) => ({
  id: d.id, source: d.src, file_url: FILE, status: d.status, doc_type: "invoice",
  confidence: 0.95, has_supporting_document: d.has_doc,
  uploaded_at: `${d.date}T08:30:00Z`,
})));

console.log("inserting extracted fields + line items…");
for (const d of DOCS) {
  const [ef] = await post("extracted_fields", [{
    document_id: d.id, doc_type: "invoice", vendor_raw: d.vendor,
    total_amount: d.total, invoice_date: d.date, currency: "AED", tax_amount: d.vat,
    invoice_number: d.num, due_date: d.due, ai_fallback_used: false,
    confidence_scores: { vendor_raw: 0.98, total_amount: 0.99, invoice_date: 0.97 },
  }]);
  await post("extracted_line_items", d.lines.map(([desc, qty, rate], i) => ({
    document_id: d.id, extracted_fields_id: ef.id, line_no: i + 1,
    description: desc, quantity: qty, rate, amount: qty * rate, source: "ocr",
  })), "return=minimal");
}

// Run REAL judgment on the two under review so their checks are genuine.
// Judgment is human-only: use the demo reviewer's JWT (set by reset-demo).
const JWT = process.env.DEMO_USER_JWT;
if (!JWT) { console.log("(no DEMO_USER_JWT — skipping judgment; run via reset-demo.mjs)"); process.exit(0); }
for (const id of [DOCS[0].id, DOCS[1].id]) {
  const r = await fetch(`${U}/functions/v1/judgment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${JWT}`, apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json", "X-Actor": "demo-seed" },
    body: JSON.stringify({ document_id: id }),
  });
  const j = await r.json();
  console.log(`judgment ${id.slice(0, 8)}: all_passed=${j.all_passed} · ${(j.checks ?? []).map((c) => `${c.rule_name}=${c.passed ? "pass" : "FAIL"}`).join(", ")}`);
}
console.log("done.");
