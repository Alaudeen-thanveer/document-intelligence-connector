export interface DocumentRow {
  id: string;
  source: string;
  file_url: string;
  status: string;
  uploaded_at: string;
  doc_type: string | null;
  confidence: number | null;
}

export interface ExtractedFieldsRow {
  id: string;
  document_id: string;
  doc_type: string | null;
  vendor_raw: string | null;
  total_amount: number | string | null;
  invoice_date: string | null;
  confidence_scores: Record<string, unknown> | null;
  ai_fallback_used: boolean;
}

export interface JudgmentResultRow {
  id: string;
  document_id: string;
  rule_name: string;
  passed: boolean;
  notes: string | null;
  reviewed_by: string | null;
}

export interface ZohoEntityRow {
  id: string;
  kind: "account" | "vendor" | "customer";
  zoho_id: string;
  name: string;
  extra: Record<string, unknown> | null;
  synced_at: string;
}

export type ReviewAction = "approve" | "correct" | "reject";

export function isFlaggedStatus(status: string): boolean {
  return [
    "needs_review",
    "flagged",
    "rejected",
    "extraction_failed",
  ].includes(status);
}
