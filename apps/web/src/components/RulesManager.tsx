import { useCallback, useEffect, useState } from "react";
import { useZohoEntities } from "../hooks/useZohoEntities";
import { isPostingAccount } from "../lib/zoho";
import { supabase } from "../lib/supabase";
import type { VendorAccountRuleRow } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after any rule is added, changed, or removed. */
  onChanged: () => void;
}

/**
 * Modal for managing per-vendor default account rules:
 * "bills/expenses from vendor X post to account Y".
 */
export function RulesManager({ open, onClose, onChanged }: Props) {
  const zoho = useZohoEntities();
  const [rules, setRules] = useState<VendorAccountRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Per-row pending account edits (rule id → account id).
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [newVendorId, setNewVendorId] = useState("");
  const [newAccountId, setNewAccountId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("vendor_account_rules")
      .select(
        "id, vendor_zoho_id, vendor_name, account_zoho_id, account_name, updated_at",
      )
      .order("vendor_name");
    if (error) {
      setMsg(error.message);
      setRules([]);
    } else {
      setRules((data ?? []) as VendorAccountRuleRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setEdits({});
    setNewVendorId("");
    setNewAccountId("");
    void load();
  }, [open, load]);

  if (!open) return null;

  const accountOptions = zoho.accounts.filter(isPostingAccount);
  const vendorsWithoutRule = zoho.vendors.filter(
    (v) => !rules.some((r) => r.vendor_zoho_id === v.zoho_id),
  );

  function accountName(accountZohoId: string): string {
    return (
      zoho.accounts.find((a) => a.zoho_id === accountZohoId)?.name ?? "unknown"
    );
  }

  async function saveEdit(rule: VendorAccountRuleRow) {
    const nextAccountId = edits[rule.id];
    if (!nextAccountId || nextAccountId === rule.account_zoho_id) return;
    setBusy(true);
    setMsg(null);
    const { error } = await supabase
      .from("vendor_account_rules")
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
        `${rule.vendor_name} now defaults to ${accountName(nextAccountId)}.`,
      );
      setEdits((prev) => {
        const { [rule.id]: _done, ...rest } = prev;
        return rest;
      });
      await load();
      onChanged();
    }
    setBusy(false);
  }

  async function removeRule(rule: VendorAccountRuleRow) {
    setBusy(true);
    setMsg(null);
    const { error } = await supabase
      .from("vendor_account_rules")
      .delete()
      .eq("id", rule.id);
    if (error) {
      setMsg(`Could not remove rule: ${error.message}`);
    } else {
      setMsg(`Removed the rule for ${rule.vendor_name}.`);
      await load();
      onChanged();
    }
    setBusy(false);
  }

  async function addRule() {
    if (!newVendorId || !newAccountId) return;
    const vendor = zoho.vendors.find((v) => v.zoho_id === newVendorId);
    if (!vendor) return;
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.from("vendor_account_rules").upsert(
      {
        vendor_zoho_id: newVendorId,
        vendor_name: vendor.name,
        account_zoho_id: newAccountId,
        account_name: accountName(newAccountId),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "vendor_zoho_id" },
    );
    if (error) {
      setMsg(`Could not add rule: ${error.message}`);
    } else {
      setMsg(`${vendor.name} now defaults to ${accountName(newAccountId)}.`);
      setNewVendorId("");
      setNewAccountId("");
      await load();
      onChanged();
    }
    setBusy(false);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal panel"
        role="dialog"
        aria-label="Vendor default account rules"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-header">
          <div>
            <p className="eyebrow">Posting rules</p>
            <h2>Vendor default accounts</h2>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <p className="muted">
          When a document's vendor matches a rule, its account is prefilled
          automatically. Editing the account on a single document never changes
          the rule — only this screen (or "Update default" in review) does.
        </p>

        {loading ? (
          <p className="muted">Loading rules…</p>
        ) : rules.length === 0 ? (
          <p className="muted">No rules yet — add the first one below.</p>
        ) : (
          <ul className="rules-list">
            {rules.map((rule) => {
              const pending = edits[rule.id] ?? rule.account_zoho_id;
              const changed = pending !== rule.account_zoho_id;
              return (
                <li key={rule.id} className="rules-item">
                  <span className="rules-vendor" title={rule.vendor_name}>
                    {rule.vendor_name}
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

        <div className="section">
          <h3>Add rule</h3>
          <div className="rules-item">
            <select
              value={newVendorId}
              disabled={busy}
              onChange={(e) => setNewVendorId(e.target.value)}
            >
              <option value="">— vendor —</option>
              {vendorsWithoutRule.map((v) => (
                <option key={v.zoho_id} value={v.zoho_id}>
                  {v.name}
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
              disabled={busy || !newVendorId || !newAccountId}
              onClick={() => void addRule()}
            >
              Add rule
            </button>
          </div>
          {vendorsWithoutRule.length === 0 && zoho.vendors.length > 0 && (
            <p className="muted">Every cached vendor already has a rule.</p>
          )}
        </div>

        {msg && <p className="action-msg">{msg}</p>}
      </div>
    </div>
  );
}
