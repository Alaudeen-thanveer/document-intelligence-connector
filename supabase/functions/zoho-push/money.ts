/**
 * Money questions answered from our own cache tables before anything is
 * posted: the per-party default account, and which Zoho currency and tax
 * ids the document's currency and VAT map to.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

interface DefaultAccountRule {
  account_zoho_id: string;
  account_name: string;
}

/**
 * Per-party default account rule ("if vendor/customer is X, post to
 * account Y"). Returns null when no rule exists — there is deliberately
 * no global default account.
 */
export async function lookupDefaultAccountRule(
  supabase: SupabaseClient,
  table: "vendor_account_rules" | "customer_account_rules",
  idColumn: "vendor_zoho_id" | "customer_zoho_id",
  entityZohoId: string,
): Promise<DefaultAccountRule | null> {
  const { data, error } = await supabase
    .from(table)
    .select("account_zoho_id, account_name")
    .eq(idColumn, entityZohoId)
    .maybeSingle();
  if (error) {
    console.log(`${table} lookup failed: ${error.message}`);
    return null;
  }
  return (data as DefaultAccountRule | null) ?? null;
}

/**
 * Resolve the document's currency code and VAT amount against the synced
 * zoho_entities cache. VAT sits in Zoho's tax field, never inside the line
 * amount: when a tax rate matches, the line becomes the NET amount plus a
 * tax_id, so Zoho recomputes the same gross total the invoice shows.
 */
export async function resolveCurrencyAndTax(
  supabase: SupabaseClient,
  currencyCode: string | null | undefined,
  grossAmount: number,
  taxAmount: number | null | undefined,
): Promise<{
  currencyId: string | null;
  taxId: string | null;
  taxName: string | null;
  netRate: number | null;
  notes: string[];
}> {
  const notes: string[] = [];
  let currencyId: string | null = null;
  let taxId: string | null = null;
  let taxName: string | null = null;
  let netRate: number | null = null;

  if (currencyCode) {
    const { data } = await supabase
      .from("zoho_entities")
      .select("zoho_id")
      .eq("kind", "currency")
      .eq("name", currencyCode)
      .maybeSingle();
    if (data?.zoho_id) {
      currencyId = String(data.zoho_id);
    } else {
      notes.push(
        `currency ${currencyCode} not in synced Zoho currencies — Zoho default applies`,
      );
    }
  }

  if (taxAmount != null && taxAmount >= 0 && grossAmount > taxAmount) {
    const net = grossAmount - taxAmount;
    const pct = (taxAmount / net) * 100;
    const { data: taxes } = await supabase
      .from("zoho_entities")
      .select("zoho_id, name, extra")
      .eq("kind", "tax");
    const match = (taxes ?? []).find((t) => {
      const p = Number((t.extra as { percentage?: unknown })?.percentage);
      return Number.isFinite(p) && Math.abs(p - pct) <= 0.5;
    });
    if (match) {
      taxId = String(match.zoho_id);
      taxName = String(match.name);
      netRate = Math.round(net * 100) / 100;
    } else {
      notes.push(
        `VAT ${taxAmount} on ${grossAmount} (~${pct.toFixed(1)}%) matches no synced Zoho tax rate — posted gross without tax_id`,
      );
    }
  }

  return { currencyId, taxId, taxName, netRate, notes };
}
