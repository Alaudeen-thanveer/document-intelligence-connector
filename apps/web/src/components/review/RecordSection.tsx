/** "The record": the fields read from the document, as the reviewer corrects them. */
import { PanelSection } from "../PanelSection";
import type { ExtractedFieldsRow } from "../../types";

interface Props {
  extracted: ExtractedFieldsRow | null;
  busy: string | null;
  runExtractAndJudgment: () => Promise<void>;
  vendorRaw: string;
  setVendorRaw: (v: string) => void;
  invoiceNumber: string;
  setInvoiceNumber: (v: string) => void;
  invoiceDate: string;
  setInvoiceDate: (v: string) => void;
  dueDate: string;
  setDueDate: (v: string) => void;
  currency: string;
  setCurrency: (v: string) => void;
  totalAmount: string;
  setTotalAmount: (v: string) => void;
}

export function RecordSection({
  extracted,
  busy,
  runExtractAndJudgment,
  vendorRaw,
  setVendorRaw,
  invoiceNumber,
  setInvoiceNumber,
  invoiceDate,
  setInvoiceDate,
  dueDate,
  setDueDate,
  currency,
  setCurrency,
  totalAmount,
  setTotalAmount,
}: Props) {
  return (
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
  );
}
