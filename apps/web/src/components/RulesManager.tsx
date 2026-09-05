import { useCallback, useEffect, useState } from "react";
import { useZohoEntities } from "../hooks/useZohoEntities";
import { isIncomeAccount, isPostingAccount } from "../lib/zoho";
import { supabase } from "../lib/supabase";
import type { EntityAccountRuleRow, ZohoEntityRow } from "../types";
import { SuggestedChecks } from "./SuggestedChecks";
import { SuggestedJournalPatterns } from "./SuggestedJournalPatterns";
import { SuggestedRules } from "./SuggestedRules";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after any rule is added, changed, or removed. */
  onChanged: () => void;
  /** Recorded as decided_by on accepted / dismissed suggestions. */
  reviewerName?: string;
}

type RuleKind = "vendor" | "customer";

interface KindConfig {
  table: "vendor_account_rules" | "customer_account_rules";
  idColumn: "vendor_zoho_id" | "customer_zoho_id";
  nameColumn: "vendor_name" | "customer_name";
  partyLabel: string;
  accountFilter: (a: ZohoEntityRow) => boolean;
}

const KIND_CONFIG: Record<RuleKind, KindConfig> = {
  vendor: {
    table: "vendor_account_rules",
    idColumn: "vendor_zoho_id",
    nameColumn: "vendor_name",
    partyLabel: "vendor",
    accountFilter: isPostingAccount,
  },
  customer: {
    table: "customer_account_rules",
    idColumn: "customer_zoho_id",
    nameColumn: "customer_name",
    partyLabel: "customer",
    accountFilter: isIncomeAccount,
  },
};

/**
 * Modal for managing default account rules, in two tabs:
 * Vendor — "bills/expenses from vendor X post to account Y";
 * Customer — "invoices for customer X post to income account Y".
 */
export function RulesManager({
  open,
  onClose,
  onChanged,
  reviewerName = "reviewer",
}: Props) {
  const zoho = useZohoEntities();
  const [kind, setKind] = useState<RuleKind>("vendor");
  const [rules, setRules] = useState<EntityAccountRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Per-row pending account edits (rule id → account id).
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [newPartyId, setNewPartyId] = useState("");
  const [newAccountId, setNewAccountId] = useState("");

  const cfg = KIND_CONFIG[kind];

  const load = useCallback(async (activeKind: RuleKind) => {
    const c = KIND_CONFIG[activeKind];
    setLoading(true);
    const { data, error } = await supabase
      .from(c.table)
      .select(
        `id, entity_zoho_id:${c.idColumn}, entity_name:${c.nameColumn}, account_zoho_id, account_name, updated_at`,
      )
      .order(c.nameColumn);
    if (error) {
      setMsg(error.message);
      setRules([]);
    } else {
      setRules((data ?? []) as unknown as EntityAccountRuleRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setEdits({});
    setNewPartyId("");
    setNewAccountId("");
    void load(kind);
  }, [open, kind, load]);

  if (!open) return null;

  const parties = kind === "vendor" ? zoho.vendors : zoho.customers;
  const accountOptions = zoho.accounts.filter(cfg.accountFilter);
  const partiesWithoutRule = parties.filter(
    (p) => !rules.some((r) => r.entity_zoho_id === p.zoho_id),
  );

  function accountName(accountZohoId: string): string {
    return (
      zoho.accounts.find((a) => a.zoho_id === accountZohoId)?.name ?? "unknown"
    );
  }

  async function saveEdit(rule: EntityAccountRuleRow) {
    const nextAccountId = edits[rule.id];
    if (!nextAccountId || nextAccountId === rule.account_zoho_id) return;
    setBusy(true);
    setMsg(null);
    const { error } = await supabase
      .from(cfg.table)
      .update({
        account_zoho_id: nextAccountId,
        account_name: accountName(nextAccountId),
        updated_at: new Date().toISOString(),
      })
      .eq("id", rule.id);
    if (error) {
      setMsg(`Could not update rule: ${error.message}`);
    } else {
      setMsg(
        `${rule.entity_name} now defaults to ${accountName(nextAccountId)}.`,
      );
      setEdits((prev) => {
        const { [rule.id]: _done, ...rest } = prev;
        return rest;
      });
      await load(kind);
      onChanged();
    }
    setBusy(false);
  }

  async function removeRule(rule: EntityAccountRuleRow) {
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.from(cfg.table).delete().eq("id", rule.id);
    if (error) {
      setMsg(`Could not remove rule: ${error.message}`);
    } else {
      setMsg(`Removed the rule for ${rule.entity_name}.`);
      await load(kind);
      onChanged();
    }
    setBusy(false);
  }

  async function addRule() {
    if (!newPartyId || !newAccountId) return;
    const party = parties.find((p) => p.zoho_id === newPartyId);
    if (!party) return;
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.from(cfg.table).upsert(
      {
        [cfg.idColumn]: newPartyId,
        [cfg.nameColumn]: party.name,
        account_zoho_id: newAccountId,
        account_name: accountName(newAccountId),
        updated_at: new Date().toISOString(),
      },
      { onConflict: cfg.idColumn },
    );
    if (error) {
      setMsg(`Could not add rule: ${error.message}`);
    } else {
      setMsg(`${party.name} now defaults to ${accountName(newAccountId)}.`);
      setNewPartyId("");
      setNewAccountId("");
      await load(kind);
      onChanged();
    }
    setBusy(false);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal panel"
        role="dialog"
        aria-label="Default account rules"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-header">
          <div>
            <p className="eyebrow">Posting rules</p>
            <h2>Default accounts</h2>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="tab-row" role="tablist">
          {(["vendor", "customer"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={`tab-btn${kind === k ? " active" : ""}`}
              onClick={() => setKind(k)}
            >
              {k === "vendor" ? "Vendors" : "Customers"}
            </button>
          ))}
        </div>

        <p className="muted">
          {kind === "vendor"
            ? "Bills and expenses from a matched vendor prefill this account."
            : "Invoices for a matched customer prefill this income account."}{" "}
          Editing the account on a single document never changes the rule.
        </p>

        {loading ? (
          <p className="muted">Loading rules…</p>
        ) : rules.length === 0 ? (
          <p className="muted">
            No {cfg.partyLabel} rules yet — add the first one below.
          </p>
        ) : (
          <ul className="rules-list">
            {rules.map((rule) => {
              const pending = edits[rule.id] ?? rule.account_zoho_id;
              const changed = pending !== rule.account_zoho_id;
              return (
                <li key={rule.id} className="rules-item">
                  <span className="rules-vendor" title={rule.entity_name}>
                    {rule.entity_name}
                  </span>
                  <select
                    value={pending}
                    disabled={busy}
                    onChange={(e) =>
                      setEdits((prev) => ({
                        ...prev,
                        [rule.id]: e.target.value,
                      }))
                    }
                  >
                    {accountOptions.map((a) => (
                      <option key={a.zoho_id} value={a.zoho_id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <span className="rule-actions">
                    <button
                      type="button"
                      className="btn ghost btn-small"
                      disabled={busy || !changed}
                      onClick={() => void saveEdit(rule)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn danger btn-small"
                      disabled={busy}
                      onClick={() => void removeRule(rule)}
                    >
                      Delete
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <SuggestedRules
          kind={kind}
          reviewerName={reviewerName}
          partyIdsWithRule={new Set(rules.map((r) => r.entity_zoho_id))}
          onAccepted={() => {
            void load(kind);
            onChanged();
          }}
        />

        <SuggestedChecks kind={kind} reviewerName={reviewerName} />

        {kind === "vendor" && (
          <SuggestedJournalPatterns reviewerName={reviewerName} />
        )}

        <div className="section">
          <h3>Add rule</h3>
          <div className="rules-item">
            <select
              value={newPartyId}
              disabled={busy}
              onChange={(e) => setNewPartyId(e.target.value)}
            >
              <option value="">{`— ${cfg.partyLabel} —`}</option>
              {partiesWithoutRule.map((p) => (
                <option key={p.zoho_id} value={p.zoho_id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={newAccountId}
              disabled={busy}
              onChange={(e) => setNewAccountId(e.target.value)}
            >
              <option value="">— account —</option>
              {accountOptions.map((a) => (
                <option key={a.zoho_id} value={a.zoho_id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn primary btn-small"
              disabled={busy || !newPartyId || !newAccountId}
              onClick={() => void addRule()}
            >
              Add rule
            </button>
          </div>
          {parties.length === 0 ? (
            <p className="muted">
              No {cfg.partyLabel}s cached yet — use "Sync from Zoho" in the
              review panel first.
            </p>
          ) : (
            partiesWithoutRule.length === 0 && (
              <p className="muted">
                Every cached {cfg.partyLabel} already has a rule.
              </p>
            )
          )}
        </div>

        {msg && <p className="action-msg">{msg}</p>}
      </div>
    </div>
  );
}
