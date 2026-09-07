/** "Lines": the editable line grid, with per-line account, project and tags. */
import type { Dispatch, SetStateAction } from "react";
import { PanelSection } from "../PanelSection";
import type { ZohoEntityRow } from "../../types";
import type { useZohoEntities } from "../../hooks/useZohoEntities";
import { nextLineKey, type EditableLine, type TagMeta } from "./model";

interface Props {
  lineItems: EditableLine[];
  setLineItems: Dispatch<SetStateAction<EditableLine[]>>;
  /** Accounts a line may post to (already filtered by the parent). */
  accountOptions: ZohoEntityRow[];
  /** The synced Zoho masters; read here for projects. */
  zoho: ReturnType<typeof useZohoEntities>;
  /** Reporting tags applied per line (transaction-level ones live in Posting). */
  lineTags: TagMeta[];
  taxAmount: string;
  totalAmount: string;
}

export function LinesSection({
  lineItems,
  setLineItems,
  accountOptions,
  zoho,
  lineTags,
  taxAmount,
  totalAmount,
}: Props) {
  return (
        <PanelSection
          id="lines"
          title="Lines"
          note={lineItems.length ? `${lineItems.length}` : "None read"}
          defaultOpen={lineItems.length > 0}
        >
          {lineItems.length === 0 && (
            <p className="muted">
              No line items captured — the whole amount posts as one line.
              Add lines to split it.
            </p>
          )}
          {lineItems.length > 0 && (
            <div className="line-item-head" aria-hidden="true">
              <span>Description</span>
              <span>Qty</span>
              <span>Rate</span>
            </div>
          )}
          {lineItems.map((li, idx) => (
            <div key={li.key} className="line-item-row">
              <input
                className="li-desc"
                aria-label={`Line ${idx + 1} description`}
                value={li.description}
                placeholder={`Line ${idx + 1} description`}
                onChange={(e) =>
                  setLineItems((prev) =>
                    prev.map((p) =>
                      p.key === li.key
                        ? { ...p, description: e.target.value }
                        : p,
                    ),
                  )
                }
              />
              <input
                className="li-qty"
                aria-label={`Line ${idx + 1} quantity`}
                value={li.quantity}
                inputMode="decimal"
                placeholder="Qty"
                onChange={(e) =>
                  setLineItems((prev) =>
                    prev.map((p) =>
                      p.key === li.key
                        ? { ...p, quantity: e.target.value }
                        : p,
                    ),
                  )
                }
              />
              <input
                className="li-rate"
                aria-label={`Line ${idx + 1} rate`}
                value={li.rate}
                inputMode="decimal"
                placeholder="Rate"
                onChange={(e) =>
                  setLineItems((prev) =>
                    prev.map((p) =>
                      p.key === li.key ? { ...p, rate: e.target.value } : p,
                    ),
                  )
                }
              />
              <select
                className="li-account"
                aria-label={`Line ${idx + 1} account`}
                value={li.accountId}
                onChange={(e) =>
                  setLineItems((prev) =>
                    prev.map((p) =>
                      p.key === li.key
                        ? { ...p, accountId: e.target.value }
                        : p,
                    ),
                  )
                }
              >
                <option value="">— account: use default —</option>
                {accountOptions.map((a) => (
                  <option key={a.zoho_id} value={a.zoho_id}>
                    {a.name}
                  </option>
                ))}
              </select>
              {(zoho.projects.length > 0 || lineTags.length > 0) && (
                <div className="li-dims">
                  {zoho.projects.length > 0 && (
                    <select
                      className="li-project"
                      value={li.projectId}
                      title="Project"
                      onChange={(e) =>
                        setLineItems((prev) =>
                          prev.map((p) =>
                            p.key === li.key
                              ? { ...p, projectId: e.target.value }
                              : p,
                          ),
                        )
                      }
                    >
                      <option value="">— project —</option>
                      {zoho.projects.map((pr) => (
                        <option key={pr.zoho_id} value={pr.zoho_id}>
                          {pr.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {lineTags.map((tag) => {
                    const options = tag.options;
                    return (
                      <select
                        key={tag.zoho_id}
                        className="li-tag"
                        value={li.tags[tag.zoho_id] ?? ""}
                        title={tag.name}
                        onChange={(e) =>
                          setLineItems((prev) =>
                            prev.map((p) =>
                              p.key === li.key
                                ? {
                                  ...p,
                                  tags: { ...p.tags, [tag.zoho_id]: e.target.value },
                                }
                                : p,
                            ),
                          )
                        }
                      >
                        <option value="">— {tag.name} —</option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    );
                  })}
                </div>
              )}
              <span className="li-amount">
                {(() => {
                  const q = Number(li.quantity) || 1;
                  const r = Number(li.rate);
                  return Number.isFinite(r) && li.rate.trim() !== ""
                    ? (q * r).toFixed(2)
                    : "—";
                })()}
              </span>
              <button
                type="button"
                className="btn ghost btn-small"
                onClick={() =>
                  setLineItems((prev) => prev.filter((p) => p.key !== li.key))
                }
              >
                ✕
              </button>
            </div>
          ))}
          <div className="line-items-footer">
            <button
              type="button"
              className="btn ghost btn-small"
              onClick={() =>
                setLineItems((prev) => [
                  ...prev,
                  {
                    key: nextLineKey(),
                    description: "",
                    quantity: "1",
                    rate: "",
                    accountId: "",
                    projectId: "",
                    tags: {},
                  },
                ])
              }
            >
              + Add line
            </button>
            {lineItems.length > 0 && (
              <span className="muted">
                {(() => {
                  const sum = lineItems.reduce((acc, li) => {
                    const q = Number(li.quantity) || 1;
                    const r = Number(li.rate);
                    return acc +
                      (Number.isFinite(r) && li.rate.trim() !== "" ? q * r : 0);
                  }, 0);
                  const vat = taxAmount.trim() === "" ? 0 : Number(taxAmount);
                  const total = totalAmount.trim() === ""
                    ? null
                    : Number(totalAmount);
                  const expected = sum + (Number.isFinite(vat) ? vat : 0);
                  const mismatch = total != null &&
                    Math.abs(expected - total) > 0.01;
                  return `Lines ${sum.toFixed(2)} + VAT ${
                    (Number.isFinite(vat) ? vat : 0).toFixed(2)
                  } = ${expected.toFixed(2)}` +
                    (mismatch
                      ? ` — does not match total ${total?.toFixed(2)}`
                      : "");
                })()}
              </span>
            )}
          </div>
        </PanelSection>
  );
}
