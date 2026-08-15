import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { ExtractedFieldsRow, JudgmentResultRow } from "../types";

export function useDocumentDetail(
  documentId: string | null,
  refreshKey = 0,
) {
  const [extracted, setExtracted] = useState<ExtractedFieldsRow | null>(null);
  const [judgments, setJudgments] = useState<JudgmentResultRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!documentId) {
      setExtracted(null);
      setJudgments([]);
      setError(null);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      const [extractedRes, judgmentRes] = await Promise.all([
        supabase
          .from("extracted_fields")
          .select(
            "id, document_id, doc_type, vendor_raw, total_amount, invoice_date, currency, tax_amount, invoice_number, due_date, customer_raw, confidence_scores, ai_fallback_used",
          )
          .eq("document_id", documentId)
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("judgment_results")
          .select("id, document_id, rule_name, passed, notes, reviewed_by")
          .eq("document_id", documentId)
          .order("rule_name", { ascending: true }),
      ]);

      if (cancelled) return;

      if (extractedRes.error || judgmentRes.error) {
        setError(
          extractedRes.error?.message ??
            judgmentRes.error?.message ??
            "Failed to load detail",
        );
      } else {
        setError(null);
        setExtracted((extractedRes.data as ExtractedFieldsRow | null) ?? null);
        setJudgments((judgmentRes.data ?? []) as JudgmentResultRow[]);
      }
      setLoading(false);
    }

    void load();

    const channel = supabase
      .channel(`document-detail-${documentId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "extracted_fields",
          filter: `document_id=eq.${documentId}`,
        },
        () => {
          void load();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "judgment_results",
          filter: `document_id=eq.${documentId}`,
        },
        () => {
          void load();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [documentId, refreshKey]);

  return { extracted, judgments, loading, error, setExtracted, setJudgments };
}
