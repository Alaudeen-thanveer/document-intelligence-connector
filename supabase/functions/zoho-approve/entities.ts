/**
 * The synced Zoho masters approve matches against — vendors, accounts —
 * and the per-party default-account rules. Read from our own cache tables;
 * Zoho is not called here.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ZohoAccount, ZohoVendor } from "../zoho-push/match-entities.ts";

export async function loadCachedVendors(
  supabase: SupabaseClient,
): Promise<ZohoVendor[]> {
  const { data } = await supabase
    .from("zoho_entities")
    .select("zoho_id, name")
    .eq("kind", "vendor");
  return (data ?? []).map((r) => ({
    vendor_id: String(r.zoho_id),
    vendor_name: String(r.name),
  }));
}

export async function loadCachedAccounts(
  supabase: SupabaseClient,
): Promise<ZohoAccount[]> {
  const { data } = await supabase
    .from("zoho_entities")
    .select("zoho_id, name, extra")
    .eq("kind", "account");
  return (data ?? []).map((r) => ({
    account_id: String(r.zoho_id),
    account_name: String(r.name),
    account_type: (r.extra as { account_type?: unknown } | null)?.account_type !=
        null
      ? String((r.extra as { account_type?: unknown }).account_type)
      : null,
  }));
}

export async function lookupDefaultAccount(
  supabase: SupabaseClient,
  table: "vendor_account_rules" | "customer_account_rules",
  idColumn: "vendor_zoho_id" | "customer_zoho_id",
  entityZohoId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from(table)
    .select("account_zoho_id")
    .eq(idColumn, entityZohoId)
    .maybeSingle();
  return data?.account_zoho_id ? String(data.account_zoho_id) : null;
}
