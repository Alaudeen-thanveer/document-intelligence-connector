/**
 * The source document's bytes: this company's folder of the document store
 * only, through a short-lived signed URL. Never an arbitrary URL.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { loadCompanyFile } from "../_shared/storage.ts";

export async function loadDocumentBytes(
  supabase: SupabaseClient,
  fileUrl: string,
  companyId: string,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  return await loadCompanyFile(supabase, fileUrl, companyId);
}
