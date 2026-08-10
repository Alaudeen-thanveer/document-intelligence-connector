/**
 * Judgment rules engine — scaffold only.
 *
 * Each rule is an independent, pluggable function:
 *   (extracted_fields row) → { rule_name, passed, notes }
 *
 * Do not invent rule content here. Register real rules by hand and
 * document each one in /docs/rules-registry.md as it is written.
 */

/** Shape of an `extracted_fields` row passed into judgment rules. */
export interface ExtractedFieldsRow {
  id?: string;
  document_id?: string;
  doc_type?: string | null;
  vendor_raw: string | null;
  total_amount: number | string | null;
  invoice_date: string | Date | null;
  confidence_scores?: unknown;
  raw_ocr_json?: unknown;
  ai_fallback_used?: boolean;
}

/** Result returned by every judgment rule. */
export interface JudgmentRuleResult {
  rule_name: string;
  passed: boolean;
  notes: string;
}

/** Independent, pluggable judgment rule. */
export type JudgmentRule = (
  row: ExtractedFieldsRow,
) => JudgmentRuleResult | Promise<JudgmentRuleResult>;

const registry = new Map<string, JudgmentRule>();

/**
 * Register (or replace) a named rule.
 * Call this from hand-written rule modules — do not invent rules here.
 */
export function registerRule(ruleName: string, rule: JudgmentRule): void {
  const name = ruleName.trim();
  if (!name) {
    throw new Error("registerRule: ruleName is required");
  }
  registry.set(name, rule);
}

/** Remove a previously registered rule (useful in tests). */
export function unregisterRule(ruleName: string): boolean {
  return registry.delete(ruleName);
}

/** List registered rule names in registration order. */
export function listRegisteredRules(): string[] {
  return [...registry.keys()];
}

/** Clear the entire registry (useful in tests). */
export function clearRules(): void {
  registry.clear();
}

export interface JudgmentRunResult {
  results: JudgmentRuleResult[];
  /** True only when every registered rule passed. */
  all_passed: boolean;
}

/**
 * Run all registered rules against one extracted_fields row.
 * Rules execute in registration order. An empty registry returns all_passed=true.
 */
export async function runJudgment(
  row: ExtractedFieldsRow,
): Promise<JudgmentRunResult> {
  const results: JudgmentRuleResult[] = [];

  for (const [registeredName, rule] of registry) {
    const result = await rule(row);
    results.push({
      rule_name: result.rule_name || registeredName,
      passed: Boolean(result.passed),
      notes: result.notes ?? "",
    });
  }

  return {
    results,
    all_passed: results.every((r) => r.passed),
  };
}
