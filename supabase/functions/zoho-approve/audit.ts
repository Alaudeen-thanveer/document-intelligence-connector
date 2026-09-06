/**
 * What approve writes about itself: the audit row and the document's
 * status. Both scoped by company; both log rather than throw, so a failed
 * write-up never undoes a posting that succeeded.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function writeAudit(
  supabase: SupabaseClient,
  row: {
    company_id: string;
    invoice_id: string;
    actor_id: string;
    action: "zoho_synced" | "zoho_sync_failed";
    detail: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.from("audit_log").insert({
    company_id: row.company_id,
    invoice_id: row.invoice_id,
    actor_type: "human",
    actor_id: row.actor_id,
    action: row.action,
    detail: row.detail,
  });
  if (error) {
    console.error("audit_log insert failed:", error.message);
  }
}

export async function markDocument(
  supabase: SupabaseClient,
  invoiceId: string,
  companyId: string,
  patch: { status: string; zoho_bill_id?: string | null },
): Promise<void> {
  const { error } = await supabase
    .from("documents")
    .update(patch)
    .eq("id", invoiceId)
    .eq("company_id", companyId);
  if (error) {
    console.error("documents update failed:", error.message);
  }
}
