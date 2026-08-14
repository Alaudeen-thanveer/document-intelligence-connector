import { useCallback, useEffect, useState } from "react";
import { callEdgeFunction } from "../lib/functions";
import { supabase } from "../lib/supabase";
import type { ZohoEntityRow } from "../types";

/**
 * Cached Zoho Books masters (chart of accounts, vendors, customers,
 * reporting tags, currencies, projects, taxes, bank accounts, payment terms,
 * items, users) from the zoho_entities table, plus a sync() that refreshes
 * them via the zoho-pull edge function (needs functions serve running with
 * Zoho credentials).
 */
export function useZohoEntities() {
  const [rows, setRows] = useState<ZohoEntityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: queryError } = await supabase
      .from("zoho_entities")
      .select("id, kind, zoho_id, name, extra, synced_at")
      .order("name");
    if (queryError) {
      setError(queryError.message);
      setRows([]);
    } else {
      setError(null);
      setRows((data ?? []) as ZohoEntityRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    const res = await callEdgeFunction("zoho-pull", {});
    if (!res.ok) {
      setError(
        String(
          res.body.error ??
            `Zoho sync failed (${res.status}) — is functions serve running?`,
        ),
      );
    }
    await load();
    setSyncing(false);
    return res.ok;
  }, [load]);

  return {
    accounts: rows.filter((r) => r.kind === "account"),
    vendors: rows.filter((r) => r.kind === "vendor"),
    customers: rows.filter((r) => r.kind === "customer"),
    reportingTags: rows.filter((r) => r.kind === "reporting_tag"),
    currencies: rows.filter((r) => r.kind === "currency"),
    projects: rows.filter((r) => r.kind === "project"),
    taxes: rows.filter((r) => r.kind === "tax"),
    bankAccounts: rows.filter((r) => r.kind === "bank_account"),
    paymentTerms: rows.filter((r) => r.kind === "payment_term"),
    items: rows.filter((r) => r.kind === "item"),
    users: rows.filter((r) => r.kind === "user"),
    loading,
    syncing,
    error,
    sync,
  };
}
