/**
 * Is this file safe to store and hand to OCR?
 *
 * The inbound mailbox is the one path where anyone on the internet can put a
 * file into a client's books, so every file that enters storage is checked
 * here first:
 *
 *   1. size — no larger than the bucket accepts;
 *   2. type — decided by the file's own first bytes, never by the filename or
 *      the Content-Type a sender claims. Only PDF, PNG, JPEG and WebP pass;
 *   3. malware — when a scanner is configured, the bytes are sent to it and
 *      anything it does not call clean is refused.
 *
 * Scanner contract (MALWARE_SCAN_URL): POST the raw bytes as
 * application/octet-stream, optional `Authorization: Bearer MALWARE_SCAN_TOKEN`;
 * answer JSON `{ "clean": true }` or `{ "clean": false, "threat": "…" }`.
 * Any other answer, a timeout or an error counts as not clean.
 *
 * With no scanner configured: a local stack accepts files (with a warning),
 * a hosted one refuses them unless MALWARE_SCAN_REQUIRED=false is set
 * deliberately. Failing closed is the point.
 */
import { isLocalStack } from "./environment.ts";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const ALLOWED_FILE_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type AllowedFileType = (typeof ALLOWED_FILE_TYPES)[number];

export class UnsafeFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeFile";
  }
}

/** The type the bytes actually are, or null when not one we accept. */
export function sniffFileType(bytes: Uint8Array): AllowedFileType | null {
  const b = bytes;
  const starts = (sig: number[], at = 0) =>
    b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
  // %PDF- may follow a little leading junk; the spec tolerates 1024 bytes.
  const head = new TextDecoder("latin1").decode(b.subarray(0, Math.min(b.length, 1024)));
  if (head.includes("%PDF-")) return "application/pdf";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

async function scanForMalware(bytes: Uint8Array, filename: string): Promise<void> {
  const scanUrl = Deno.env.get("MALWARE_SCAN_URL")?.trim();
  if (!scanUrl) {
    const required = (Deno.env.get("MALWARE_SCAN_REQUIRED") ?? "").trim().toLowerCase();
    if (required === "true" || (required !== "false" && !isLocalStack())) {
      throw new UnsafeFile(
        "Files cannot be accepted: no malware scanner is configured (MALWARE_SCAN_URL).",
      );
    }
    console.warn("MALWARE_SCAN_URL is not set: file accepted without a malware scan (local stack).");
    return;
  }

  const token = Deno.env.get("MALWARE_SCAN_TOKEN")?.trim();
  let verdict: { clean?: unknown; threat?: unknown } = {};
  try {
    const res = await fetch(scanUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(filename).slice(0, 200),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: bytes as BodyInit,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    verdict = await res.json().catch(() => ({}));
    if (!res.ok) verdict = {};
  } catch (err) {
    console.error(`malware scan unavailable: ${err instanceof Error ? err.name : "error"}`);
    throw new UnsafeFile("The file could not be scanned for malware, so it was not accepted.");
  }
  if (verdict.clean !== true) {
    const threat = typeof verdict.threat === "string" ? verdict.threat.slice(0, 80) : null;
    console.warn(`file refused by malware scan${threat ? `: ${threat}` : ""}`);
    throw new UnsafeFile("The file was refused by the malware scan.");
  }
}

/**
 * Check a file before it is stored. Returns the type the bytes really are,
 * which is what should be stored as its Content-Type.
 */
export async function assertSafeFile(
  bytes: Uint8Array,
  filename: string,
): Promise<AllowedFileType> {
  if (bytes.length === 0) throw new UnsafeFile("The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new UnsafeFile(`The file is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  }
  const type = sniffFileType(bytes);
  if (!type) throw new UnsafeFile("Only PDF, PNG, JPEG or WebP files are accepted.");
  await scanForMalware(bytes, filename);
  return type;
}
