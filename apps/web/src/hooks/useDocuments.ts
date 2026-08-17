import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { DocumentRow } from "../types";

export function useDocuments() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data, error: queryError } = await supabase
        .from("documents")
        .select("id, source, file_url, status, uploaded_at, doc_type, confidence, zoho_bill_id")
        .order("uploaded_at", { ascending: false });

      if (cancelled) return;
      if (queryError) {
        setError(queryError.message);
        setDocuments([]);
      } else {
        setError(null);
        setDocuments((data ?? []) as DocumentRow[]);
      }
      setLoading(false);
    }

    void load();

    const channel = supabase
      .channel("documents-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "documents" },
        () => {
          void load();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, []);

  return { documents, loading, error, setDocuments };
}
