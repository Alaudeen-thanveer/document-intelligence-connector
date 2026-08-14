import { useState } from "react";
import { useZohoEntities } from "../hooks/useZohoEntities";
import type { ZohoEntityRow } from "../types";

/** One synced entity category inside a connection card. */
interface KindSection {
  key: ZohoEntityRow["kind"];
  label: string;
  /** Secondary line shown under an entity name in the expanded list. */
  detail: (row: ZohoEntityRow) => string;
  /** Shown when the kind has zero cached rows. */
  emptyHint: string;
}

const ZOHO_KINDS: KindSection[] = [
  {
    key: "account",
    label: "Chart of accounts",
    detail: (r) =>
      String((r.extra as { account_type?: unknown })?.account_type ?? ""),
    emptyHint: "No accounts cached yet — run a sync.",
  },
  {
    key: "vendor",
    label: "Vendors",
    detail: (r) => String((r.extra as { status?: unknown })?.status ?? ""),
    emptyHint: "No vendors cached yet — run a sync.",
  },
  {
    key: "customer",
    label: "Customers",
    detail: (r) => String((r.extra as { status?: unknown })?.status ?? ""),
    emptyHint: "No customers cached yet — run a sync.",
  },
  {
    key: "currency",
    label: "Currencies",
    detail: (r) => {
      const extra = r.extra as {
        currency_name?: unknown;
        symbol?: unknown;
      } | null;
      return [extra?.currency_name, extra?.symbol]
        .filter(Boolean)
        .join(" · ");
    },
    emptyHint: "No currencies cached yet — run a sync.",
  },
  {
    key: "project",
    label: "Projects",
    detail: (r) => {
      const extra = r.extra as {
        customer_name?: unknown;
        status?: unknown;
      } | null;
      return [extra?.customer_name, extra?.status].filter(Boolean).join(" · ");
    },
    emptyHint: "No projects cached yet — run a sync.",
  },
  {
    key: "reporting_tag",
    label: "Reporting tags",
    detail: (r) => {
      const options = (r.extra as { options?: unknown[] } | null)?.options;
      return Array.isArray(options) ? `${options.length} option(s)` : "";
    },
    emptyHint:
      "None defined in Zoho Books yet (Settings → Reporting Tags), or not synced.",
  },
  {
    key: "tax",
    label: "Taxes",
    detail: (r) => {
      const extra = r.extra as {
        percentage?: unknown;
        tax_type?: unknown;
      } | null;
      return [
        extra?.percentage != null ? `${extra.percentage}%` : null,
        extra?.tax_type,
      ]
        .filter(Boolean)
        .join(" · ");
    },
    emptyHint:
      "No tax rates defined in Zoho Books yet (Settings → Taxes), or not synced.",
  },
  {
    key: "bank_account",
    label: "Bank accounts",
    detail: (r) => {
      const extra = r.extra as {
        account_type?: unknown;
        currency_code?: unknown;
      } | null;
      return [extra?.account_type, extra?.currency_code]
        .filter(Boolean)
        .join(" · ");
    },
    emptyHint: "No bank or cash accounts cached yet — run a sync.",
  },
  {
    key: "payment_term",
    label: "Payment terms",
    detail: (r) => {
      // Zoho encodes "due end of month"-style terms as negative day codes;
      // the term name already says it, so only show real day counts.
      const days = Number((r.extra as { days?: unknown } | null)?.days);
      return Number.isFinite(days) && days >= 0 ? `${days} day(s)` : "";
    },
    emptyHint: "No payment terms cached yet — run a sync.",
  },
  {
    key: "item",
    label: "Items",
    detail: (r) => {
      const extra = r.extra as {
        rate?: unknown;
        product_type?: unknown;
      } | null;
      return [extra?.product_type, extra?.rate != null ? String(extra.rate) : null]
        .filter(Boolean)
        .join(" · ");
    },
    emptyHint:
      "No items defined in Zoho Books yet (Items), or not synced.",
  },
  {
    key: "user",
    label: "Users",
    detail: (r) => {
      const extra = r.extra as { email?: unknown; role?: unknown } | null;
      return [extra?.email, extra?.role].filter(Boolean).join(" · ");
    },
    emptyHint: "No users cached yet — run a sync.",
  },
];

function formatSynced(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleString();
}

/**
 * Connections — one card per external system this app syncs with, showing
 * exactly what is cached locally from it. Only Zoho Books exists today;
 * future connections get their own card here.
 */
export function ConnectionsPage() {
  const zoho = useZohoEntities();
  const [expandedKind, setExpandedKind] = useState<
    ZohoEntityRow["kind"] | null
  >(null);

  const allRows = [
    ...zoho.accounts,
    ...zoho.vendors,
    ...zoho.customers,
    ...zoho.reportingTags,
    ...zoho.currencies,
    ...zoho.projects,
    ...zoho.taxes,
    ...zoho.bankAccounts,
    ...zoho.paymentTerms,
    ...zoho.items,
    ...zoho.users,
  ];

  const byKind = (kind: ZohoEntityRow["kind"]): ZohoEntityRow[] =>
    allRows.filter((r) => r.kind === kind);

  const lastSynced = allRows.reduce<string | null>(
    (latest, r) =>
      latest === null || r.synced_at > latest ? r.synced_at : latest,
    null,
  );

  const expanded = expandedKind ? byKind(expandedKind) : [];
  const expandedSection = ZOHO_KINDS.find((k) => k.key === expandedKind);

  return (
    <main className="connections-layout">
      <div className="pane-heading">
        <h2>Connections</h2>
      </div>
      <p className="muted connections-intro">
        External systems this app syncs with, and exactly what is cached
        locally from each.
      </p>

      <section className="panel connection-card">
        <header className="panel-header">
          <div>
            <p className="eyebrow">Accounting</p>
            <h2>Zoho Books</h2>
          </div>
          <div className="conn-header-side">
            <span
              className={`status-pill ${
                allRows.length > 0 ? "status-synced" : "status-needs_review"
              }`}
            >
              {allRows.length > 0 ? "synced" : "not synced"}
            </span>
            <button
              type="button"
              className="btn primary"
              disabled={zoho.syncing}
              onClick={() => void zoho.sync()}
            >
              {zoho.syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
        </header>

        <p className="muted">
          Last synced: {formatSynced(lastSynced)}
          {zoho.error && <span className="error-text"> — {zoho.error}</span>}
        </p>

        {zoho.loading ? (
          <p className="muted">Loading cached entities…</p>
        ) : (
          <div className="conn-kind-grid">
            {ZOHO_KINDS.map((section) => {
              const rows = byKind(section.key);
              const active = expandedKind === section.key;
              return (
                <button
                  key={section.key}
                  type="button"
                  className={`conn-kind-tile${active ? " active" : ""}`}
                  onClick={() =>
                    setExpandedKind(active ? null : section.key)
                  }
                >
                  <span className="conn-kind-count">{rows.length}</span>
                  <span className="conn-kind-label">{section.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {expandedSection && (
          <div className="section">
            <h3>{expandedSection.label}</h3>
            {expanded.length === 0 ? (
              <p className="muted">{expandedSection.emptyHint}</p>
            ) : (
              <ul className="conn-entity-list">
                {expanded.map((row) => {
                  const detail = expandedSection.detail(row);
                  return (
                    <li key={row.id}>
                      <strong>{row.name}</strong>
                      {detail && <span>{detail}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
