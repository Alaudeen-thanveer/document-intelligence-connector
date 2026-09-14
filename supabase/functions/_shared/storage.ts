/**
 * Reading a stored document, and nothing but a stored document.
 *
 * documents.file_url and bank_statements.file_url used to be followed
 * wherever they pointed. A path in the invoices bucket was downloaded with
 * the service role, so a row pointing at invoices/<another company>/… read
 * that company's file; anything else was handed straight to fetch(), so a row
 * pointing at an internal address made the server request it (SSRF).
 *
 * Now a file is read only when:
 *   - it resolves to an object in the invoices bucket (a storage:// ref, a
 *     legacy Supabase storage URL, or a bare object path) — never an
 *     arbitrary URL;
 *   - the object path sits under the company the caller was already
 *     verified for (`{companyId}/…`), with no traversal; and
 *   - it is fetched through a short-lived signed URL minted by the client the
 *     function was given, so when that client carries the user's JWT, storage
 *     row-level security applies to the signing too.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const INVOICES_BUCKET = "invoices";

/** How long a function-internal signed URL lives. Used once, immediately. */
export const INTERNAL_SIGNED_URL_SECONDS = 60;

const STORAGE_MARKERS = [
  "storage://invoices/",
  "/storage/v1/object/public/invoices/",
  "/storage/v1/object/sign/invoices/",
  "/storage/v1/object/authenticated/invoices/",
];

export class StoredFileRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredFileRefused";
  }
}

/** The object path inside the invoices bucket, or null when the ref is not one. */
export function invoiceObjectPath(fileUrl: string | null | undefined): string | null {
  const ref = (fileUrl ?? "").trim();
  if (!ref) return null;
  for (const marker of STORAGE_MARKERS) {
    const idx = ref.indexOf(marker);
    if (idx >= 0) {
      try {
        return decodeURIComponent(ref.slice(idx + marker.length).split("?")[0]);
      } catch {
        return null;
      }
    }
  }
  // A bare company/uuid-filename path, as some older rows store it.
  if (!ref.includes("://") && ref.includes("/")) return ref.split("?")[0];
  return null;
}

/**
 * The object path, checked to belong to companyId. Throws StoredFileRefused
 * for anything else: an external URL, another company's folder, traversal.
 */
export function companyObjectPath(fileUrl: string | null | undefined, companyId: string): string {
  const path = invoiceObjectPath(fileUrl);
  if (!path) {
    throw new StoredFileRefused("Only files held in the document store can be read");
  }
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new StoredFileRefused("That file path is not allowed");
  }
  if (segments.length < 2 || segments[0] !== companyId) {
    // Same answer whether the file exists elsewhere or not at all.
    throw new StoredFileRefused("File not found");
  }
  return path;
}

/** The canonical ref stored on a row for an object path. */
export function storageRef(path: string): string {
  return `storage://${INVOICES_BUCKET}/${path}`;
}

export type StoredFile = { bytes: Uint8Array; contentType: string; filename: string; path: string };

/** A stored file's bytes, through a short-lived signed URL, for this company only. */
export async function loadCompanyFile(
  supabase: SupabaseClient,
  fileUrl: string | null | undefined,
  companyId: string,
): Promise<StoredFile> {
  const path = companyObjectPath(fileUrl, companyId);
  const { data, error } = await supabase.storage
    .from(INVOICES_BUCKET)
    .createSignedUrl(path, INTERNAL_SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new StoredFileRefused("File not found");
  }
  const res = await fetch(data.signedUrl, { redirect: "error" });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`storage download failed (${res.status})`);
  }
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get("content-type")?.split(";")[0] || "application/pdf",
    filename: path.split("/").pop() || "document.pdf",
    path,
  };
}
