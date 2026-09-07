/**
 * What must be true of a document before it is posted: a human approved it,
 * every judgment check passed. And one read of Zoho's answer: is the file
 * attached.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function assertHumanApproved(
  supabase: SupabaseClient,
  documentId: string,
): Promise<void> {
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, status")
    .eq("id", documentId)
    .single();
  if (error || !doc) {
    throw new Error(`Document not found: ${error?.message ?? documentId}`);
  }
  if (doc.status !== "approved") {
    throw new Error(
      `Document must be human-approved before Zoho push (status=${doc.status})`,
    );
  }
}

export async function assertJudgmentsPassed(
  supabase: SupabaseClient,
  documentId: string,
): Promise<{ judgmentResultId: string | null }> {
  const { data, error } = await supabase
    .from("judgment_results")
    .select("id, rule_name, passed, notes")
    .eq("document_id", documentId);

  if (error) {
    throw new Error(`Failed to load judgment_results: ${error.message}`);
  }

  const rows = data ?? [];
  if (rows.length === 0) {
    throw new Error(
      "No judgment_results found — document is not ready for Zoho push",
    );
  }

  const failed = rows.filter((r) => !r.passed);
  if (failed.length > 0) {
    const names = failed.map((r) => r.rule_name).join(", ");
    throw new Error(`Judgment failed for rule(s): ${names}`);
  }

  const judgmentResultId = rows[rows.length - 1]?.id ?? null;
  return { judgmentResultId };
}

export function attachmentPresent(billRaw: unknown): {
  present: boolean;
  documents: unknown[];
} {
  const bill = (billRaw as { bill?: Record<string, unknown> })?.bill ??
    (billRaw as Record<string, unknown>);
  const docs = (bill?.documents as unknown[]) ??
    (bill?.document as unknown[]) ??
    [];
  const list = Array.isArray(docs) ? docs : docs ? [docs] : [];
  const name = bill?.attachment_name ?? bill?.file_name;
  return {
    present: list.length > 0 || Boolean(name),
    documents: list,
  };
}
