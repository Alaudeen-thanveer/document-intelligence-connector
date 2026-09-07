/**
 * The review panel's own small model: an editable line, how reporting tags
 * are applied (per line or per transaction), and the UAE VAT treatments.
 * Shared by the panel and its sections; nothing here touches React.
 */
export type PostAs = "bill" | "expense" | "invoice";

/** One editable invoice line in the review form. */
export interface EditableLine {
  key: string;
  description: string;
  quantity: string;
  rate: string;
  accountId: string;
  projectId: string;
  /** tag_id → tag_option_id */
  tags: Record<string, string>;
}

let lineKeyCounter = 0;
export function nextLineKey(): string {
  lineKeyCounter += 1;
  return `line-${lineKeyCounter}`;
}

/**
 * A reporting tag in Zoho is applied either per LINE ITEM or once per
 * TRANSACTION (Zoho: multi_preference_entities.preference). We mirror that
 * exactly: line-level tags get a selector on every line; transaction-level
 * tags get ONE selector in the header and are applied uniformly to every
 * line on push — so two lines can never carry different values for a
 * transaction-level tag. Draft / inactive tags, or tags with no options,
 * cannot be applied in Zoho and are not offered.
 */
export interface TagMeta {
  zoho_id: string;
  name: string;
  preference: "line_item" | "transaction";
  options: Array<{ id: string; name: string }>;
}
export function tagMeta(
  rows: Array<{ zoho_id: string; name: string; extra: Record<string, unknown> | null }>,
): TagMeta[] {
  return rows
    .map((t) => {
      const extra = (t.extra ?? {}) as {
        preference?: unknown;
        is_active?: unknown;
        is_draft?: unknown;
        options?: Array<{ id: string | null; name: string | null }>;
      };
      const options = (extra.options ?? [])
        .filter((o): o is { id: string; name: string | null } => !!o.id)
        .map((o) => ({ id: o.id, name: o.name ?? o.id }));
      const usable = extra.is_active !== false && extra.is_draft !== true &&
        options.length > 0;
      return usable
        ? {
          zoho_id: t.zoho_id,
          name: t.name,
          preference: extra.preference === "transaction"
            ? "transaction" as const
            : "line_item" as const,
          options,
        }
        : null;
    })
    .filter((t): t is TagMeta => t !== null);
}

/** UAE-edition VAT treatments (transaction-level; Zoho validates). */
export const TAX_TREATMENTS: Array<{ value: string; label: string }> = [
  { value: "vat_registered", label: "VAT registered" },
  { value: "vat_not_registered", label: "VAT not registered" },
  { value: "gcc_vat_registered", label: "GCC VAT registered" },
  { value: "gcc_vat_not_registered", label: "GCC VAT not registered" },
  { value: "non_gcc", label: "Non GCC" },
  { value: "dz_vat_registered", label: "Designated zone (registered)" },
  { value: "dz_vat_not_registered", label: "Designated zone (not registered)" },
];
