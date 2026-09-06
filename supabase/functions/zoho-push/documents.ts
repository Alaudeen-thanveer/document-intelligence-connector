/** The source document's bytes, from private storage or a fetchable URL. */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function loadDocumentBytes(
  supabase: SupabaseClient,
  fileUrl: string,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  const publicMarker = "/storage/v1/object/public/invoices/";
  const publicIdx = fileUrl.indexOf(publicMarker);
  if (publicIdx >= 0) {
    const path = decodeURIComponent(
      fileUrl.slice(publicIdx + publicMarker.length),
    );
    const { data, error } = await supabase.storage.from("invoices").download(
      path,
    );
    if (error || !data) {
      throw new Error(`storage download failed: ${error?.message ?? "no data"}`);
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    return {
      bytes,
      contentType: data.type || "application/pdf",
      filename: path.split("/").pop() || "document.pdf",
    };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
  const fetchable = fileUrl
    .replace("http://127.0.0.1:54321", supabaseUrl)
    .replace("http://localhost:54321", supabaseUrl);

  const fileRes = await fetch(fetchable);
  if (!fileRes.ok) {
    throw new Error(`Failed to fetch document file (${fileRes.status})`);
  }
  const bytes = new Uint8Array(await fileRes.arrayBuffer());
  return {
    bytes,
    contentType: fileRes.headers.get("content-type") ?? "application/pdf",
    filename: fileUrl.split("/").pop()?.split("?")[0] || "document.pdf",
  };
}
