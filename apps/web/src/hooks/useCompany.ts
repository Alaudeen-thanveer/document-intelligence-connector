import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

/** One company the signed-in person belongs to, as the switcher lists it. */
export interface MyCompany {
  company_id: string;
  company_name: string;
  role: string;
  /** The one the database is currently showing this person. */
  current: boolean;
}

/**
 * The companies this person belongs to, which one they are working in, and
 * a way to change it.
 *
 * The list and the current flag come from my_companies(); the choice is
 * written by set_current_company(), which checks membership on the
 * database side. Row-level security decides what every page shows through
 * current_company_id(), which prefers that choice, so a change here changes
 * every list on every page — and the realtime channels were opened for the
 * old company. A full reload is the one step that reaches all of them.
 */
export function useCompany() {
  const [companies, setCompanies] = useState<MyCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc("my_companies");
    if (rpcError) {
      setError(rpcError.message);
      setCompanies([]);
    } else {
      setError(null);
      setCompanies((data ?? []) as MyCompany[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = companies.find((c) => c.current) ?? null;

  const choose = useCallback(async (companyId: string) => {
    const { error: rpcError } = await supabase.rpc("set_current_company", {
      p_company_id: companyId,
    });
    if (rpcError) throw new Error(rpcError.message);
    window.location.reload();
  }, []);

  return { companies, current, loading, error, choose };
}
