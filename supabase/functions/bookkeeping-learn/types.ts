/** What the Rules screen (or a script) sends to bookkeeping-learn. */
export interface LearnInput {
  company_id?: string;
  /** How far back to read; default 24. */
  months_back?: number;
  /** Cap on documents to detail-fetch per kind, for cost control. */
  max_docs_per_kind?: number;
  /** Re-analyse from bk_history_raw without touching Zoho. */
  reanalyze_only?: boolean;
  /**
   * Re-fetch already-cached bills and invoices so status / balance reflect
   * payments made since they were first cached. Timing (layer 6) depends
   * on this; cheap for small orgs, so it defaults ON for full runs.
   */
  refresh_documents?: boolean;
}
