/** "Tax": the VAT amount on the document and the treatment for this transaction. */
import { PanelSection } from "../PanelSection";
import { TAX_TREATMENTS } from "./model";

interface Props {
  taxAmount: string;
  setTaxAmount: (v: string) => void;
  taxTreatment: string;
  setTaxTreatment: (v: string) => void;
  /** The selected party's own default treatment, if any. */
  partyTreatment: string;
  partyTreatmentLabel: string | undefined;
}

export function TaxSection({
  taxAmount,
  setTaxAmount,
  taxTreatment,
  setTaxTreatment,
  partyTreatment,
  partyTreatmentLabel,
}: Props) {
  return (
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
  );
}
