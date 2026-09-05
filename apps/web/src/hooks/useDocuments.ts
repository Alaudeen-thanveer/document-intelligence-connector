import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { DocumentRow } from "../types";

export function useDocuments() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reloadRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    // A save fires two loads at once: the caller's own reload, and the
    // realtime event the same UPDATE produced. Without a sequence number the
    // older response can land last and put pre-save data back on screen — the
    // reviewer sees their edit flash away and reads it as a lost save.
    let seq = 0;
    let everLoaded = false;

    async function load() {
      const mine = ++seq;
      // Only the first load is a real wait. Anything after it is a refresh,
      // and flashing "Loading…" every time anything in the company changes
      // makes the grid look broken.
      if (!everLoaded) setLoading(true);
      const { data, error: queryError } = await supabase
        // documents_grid is documents + its current extraction + its check
        // tally. Realtime below stays on the base table: Postgres emits no
        // postgres_changes for a view.
        .from("documents_grid")
        .select(
          "id, company_id, source, file_url, status, uploaded_at, doc_type, confidence, zoho_bill_id, has_supporting_document, ready_at, ready_by, extracted_fields_id, vendor_raw, customer_raw, invoice_number, invoice_date, due_date, total_amount, tax_amount, currency, po_number, ai_fallback_used, checks_total, checks_passed",
        )
        .order("uploaded_at", { ascending: false });

      if (cancelled || mine !== seq) return;
      everLoaded = true;
      if (queryError) {
        setError(queryError.message);
        setDocuments([]);
      } else {
        setError(null);
        setDocuments((data ?? []) as DocumentRow[]);
      }
      setLoading(false);
    }

    reloadRef.current = load;
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
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "extracted_fields" },
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

  const reload = useCallback(() => reloadRef.current(), []);

  return { documents, loading, error, setDocuments, reload };
}
