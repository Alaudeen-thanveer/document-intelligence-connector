/**
 * Statement evidence on pushed records — pure parts.
 *
 * When a statement line becomes a payment/expense in Zoho, the statement
 * itself is the evidence — so it gets attached to the record: the
 * uploaded statement file when one exists, else a small text file
 * carrying the line and its statement context (pasted/emailed statements
 * have no file). Best effort, after the record exists; a failed
 * attachment never undoes the record.
 */

export interface AttachTarget { path: string; field: "attachment" | "receipt" }

/** Where the evidence goes, per pushed kind. Refund records keep their own document links — no attachment. */
export function attachTargetFor(kind: string, zohoId: string): AttachTarget | null {
  switch (kind) {
    case "customer_payment":
    case "retainer_receipt":
      return { path: `customerpayments/${zohoId}/attachment`, field: "attachment" };
    case "vendor_payment":
      return { path: `vendorpayments/${zohoId}/attachment`, field: "attachment" };
    case "expense":
      return { path: `expenses/${zohoId}/receipt`, field: "receipt" };
    case "deposit":
    case "transfer":
    case "other":
      return { path: `banktransactions/${zohoId}/attachment`, field: "attachment" };
    default:
      return null;
  }
}

export interface EvidenceLine {
  line_no: number;
  txn_date: string;
  description: string;
  reference: string | null;
  side: "debit" | "credit";
  amount: number;
}
export interface EvidenceStatement {
  bank_account_name: string | null;
  bank_account_zoho_id: string;
  period_start: string | null;
  period_end: string | null;
  source: string;
  original_name: string | null;
  currency: string | null;
}

/**
 * A minimal one-page PDF carrying the given text lines (Helvetica 10pt).
 * Zoho refuses .txt attachments ("File types with extension txt are not
 * supported", verified live), so the note ships as a real PDF.
 */
export function textToPdf(text: string): Uint8Array {
  const esc = (l: string) =>
    l
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/[^\x20-\x7e]/g, (ch) => (ch === "\u2014" || ch === "\u2013" ? "-" : "?"));
  const lines = text.split("\n").slice(0, 60);
  const content = ["BT /F1 10 Tf 50 792 Td 14 TL", ...lines.map((l) => "(" + esc(l) + ") Tj T*"), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + String(content.length) + " >>\nstream\n" + content + "\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += String(i + 1) + " 0 obj\n" + obj + "\nendobj\n";
  });
  const xref = pdf.length;
  pdf += "xref\n0 " + String(objects.length + 1) + "\n0000000000 65535 f \n" +
    offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  pdf += "trailer\n<< /Size " + String(objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + String(xref) + "\n%%EOF";
  return new TextEncoder().encode(pdf);
}

/** The text evidence for a line when the statement has no file (pasted / emailed text). */
export function buildLineEvidence(line: EvidenceLine, stmt: EvidenceStatement, actor: string): { filename: string; text: string } {
  const bank = stmt.bank_account_name ?? stmt.bank_account_zoho_id;
  return {
    filename: `statement-line-${line.txn_date}-${line.line_no}.pdf`,
    text: [
      `Bank statement line — recorded through the Document Intelligence Connector`,
      ``,
      `Bank account : ${bank}`,
      `Statement    : ${stmt.period_start ?? "?"} to ${stmt.period_end ?? "?"} (${stmt.source}${stmt.original_name ? `, ${stmt.original_name}` : ""})`,
      ``,
      `Line ${line.line_no}`,
      `  Date       : ${line.txn_date}`,
      `  Description: ${line.description}`,
      `  Reference  : ${line.reference ?? "—"}`,
      `  ${line.side === "credit" ? "Money in " : "Money out"} : ${line.amount.toFixed(2)} ${stmt.currency ?? ""}`.trimEnd(),
      ``,
      `Confirmed by ${actor}. The statement was ${stmt.source === "paste" ? "pasted as text" : stmt.source === "email" ? "received by email as text" : "uploaded"}, so this note stands in for the page.`,
    ].join("\n"),
  };
}
