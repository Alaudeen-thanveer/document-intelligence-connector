/**
 * A Uint8Array that Blob will accept.
 *
 * Since TypeScript 5.7 a Uint8Array is generic over its buffer, and a
 * value typed Uint8Array<ArrayBufferLike> is refused as a BlobPart because
 * the buffer could be shared. Every byte array in this codebase comes from
 * fetch, base64 decoding or Storage, none of which hand out a
 * SharedArrayBuffer; this is the one place that assertion is made. No copy:
 * it is a view over the same memory.
 */
export function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}
