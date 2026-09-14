/**
 * The source document itself: fetching its bytes from private storage and
 * attaching them to the Zoho record. Best effort on the attach; never undoes
 * the record.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { blobPart } from "../_shared/bytes.ts";
import { loadCompanyFile } from "../_shared/storage.ts";
import { publicError, withZohoRetry, zohoFetch } from "./zoho_client.ts";

/**
 * The document's bytes: this company's folder of the document store only,
 * through a short-lived signed URL. Never an arbitrary URL — a row pointing
 * elsewhere used to be fetched, or another company's file downloaded.
 */
export async function loadDocumentBytes(
  supabase: SupabaseClient,
  fileUrl: string,
  companyId: string,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  return await loadCompanyFile(supabase, fileUrl, companyId);
}

/** Attach the source document to the Zoho record. Best effort; never undoes the document. */
export async function attachDocument(
  companyId: string,
  supabase: SupabaseClient,
  fileUrl: string | null,
  zohoPath: string,
  fieldName: "attachment" | "receipt",
): Promise<{ uploaded: boolean; filename?: string; error?: string }> {
  if (!fileUrl) return { uploaded: false, error: "no file on document" };
  try {
    const file = await loadDocumentBytes(supabase, fileUrl, companyId);
    const result = await withZohoRetry(companyId, async (z) => {
      const form = new FormData();
      form.append(fieldName, new Blob([blobPart(file.bytes)], { type: file.contentType }), file.filename);
      const res = await zohoFetch(`${z.apiBase}/${zohoPath}?organization_id=${encodeURIComponent(z.organizationId)}`, { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${z.accessToken}` }, body: form });
      const raw = await res.json().catch(async () => await res.text());
      return { ok: res.ok && ((raw as { code?: number })?.code ?? 0) === 0, status: res.status, raw };
    });
    return result.ok ? { uploaded: true, filename: file.filename } : { uploaded: false, filename: file.filename, error: publicError(JSON.stringify(result.raw).slice(0, 200)) };
  } catch (err) {
    return { uploaded: false, error: publicError(err) };
  }
}
