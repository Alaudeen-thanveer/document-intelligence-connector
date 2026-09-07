/**
 * The source document itself: fetching its bytes from private storage and
 * attaching them to the Zoho record. Best effort on the attach; never undoes
 * the record.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { blobPart } from "../_shared/bytes.ts";
import { publicError, withZohoRetry, zohoFetch } from "./zoho_client.ts";

/** The document's bytes: private storage ref (storage://invoices/path), legacy public URL, or a fetchable URL. */
export async function loadDocumentBytes(
  supabase: SupabaseClient,
  fileUrl: string,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  let path: string | null = null;
  if (fileUrl.startsWith("storage://invoices/")) path = fileUrl.slice("storage://invoices/".length);
  const publicMarker = "/storage/v1/object/public/invoices/";
  const idx = fileUrl.indexOf(publicMarker);
  if (!path && idx >= 0) path = decodeURIComponent(fileUrl.slice(idx + publicMarker.length));
  if (path) {
    const { data, error } = await supabase.storage.from("invoices").download(path);
    if (error || !data) throw new Error(`storage download failed: ${error?.message ?? "no data"}`);
    return { bytes: new Uint8Array(await data.arrayBuffer()), contentType: data.type || "application/pdf", filename: path.split("/").pop() || "document.pdf" };
  }
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`fetch document failed (${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/pdf", filename: fileUrl.split("/").pop()?.split("?")[0] || "document.pdf" };
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
    const file = await loadDocumentBytes(supabase, fileUrl);
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
