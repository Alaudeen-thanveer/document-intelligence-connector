/** Resolve invoices storage object path from documents.file_url. */
export function invoiceStoragePath(fileUrl: string): string | null {
  const markers = [
    "/storage/v1/object/public/invoices/",
    "/storage/v1/object/sign/invoices/",
    "/storage/v1/object/authenticated/invoices/",
    "storage://invoices/",
  ];
  for (const marker of markers) {
    const idx = fileUrl.indexOf(marker);
    if (idx >= 0) {
      return decodeURIComponent(fileUrl.slice(idx + marker.length).split("?")[0]);
    }
  }
  // Bare company/uuid-filename path
  if (!fileUrl.includes("://") && fileUrl.includes("/")) {
    return fileUrl.split("?")[0];
  }
  return null;
}

export function storageRefFromPath(path: string): string {
  return `storage://invoices/${path}`;
}
