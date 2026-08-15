/**
 * Layer 3 accuracy check: attachment conventions.
 * Synthetic per-vendor attachment histories with KNOWN conventions.
 *
 * Usage: node --experimental-strip-types scripts/bk-layer3-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { learnAttachmentConvention, MIN_ATTACH_SAMPLE } = await import(
  pathToFileURL(
    resolve(root, "supabase/functions/bookkeeping-learn/attachments.ts"),
  ).href
);

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const pdf = (name) => ({ file_name: name, file_type: "pdf" });

// Goods vendor: 20 bills, each invoice + delivery note → strict.
const goods = learnAttachmentConvention(
  Array.from({ length: 20 }, (_, i) => ({
    documents: [pdf(`INV-${i}.pdf`), pdf(`Delivery-Note-${i}.pdf`)],
  })),
);
check("goods: count_mode = 2", goods.count_mode === 2, goods.count_mode);
check("goods: multi_share = 1", goods.multi_share === 1);
check("goods: 'delivery' is a recurring token", goods.recurring_name_tokens.includes("delivery"), goods.recurring_name_tokens.join(","));
check("goods: proposed strict", goods.proposed_strictness === "strict", goods.proposed_strictness);
check("goods: rationale mentions delivery", /delivery/.test(goods.rationale), goods.rationale);
check("goods: types all pdf", goods.types.pdf === 1);
check("goods: confidence high", goods.confidence > 0.85, goods.confidence);

// Utility: 20 bills, exactly one PDF each → standard.
const util = learnAttachmentConvention(
  Array.from({ length: 20 }, (_, i) => ({ documents: [pdf(`bill-${i}.pdf`)] })),
);
check("utility: count_mode = 1", util.count_mode === 1);
check("utility: proposed standard", util.proposed_strictness === "standard", util.proposed_strictness);
check("utility: no recurring support tokens", util.recurring_name_tokens.length === 0);

// Statement-entered vendor: 20 bills, no attachments → relaxed.
const stmt = learnAttachmentConvention(
  Array.from({ length: 20 }, () => ({ documents: [] })),
);
check("statement: attached_share = 0", stmt.attached_share === 0);
check("statement: proposed relaxed", stmt.proposed_strictness === "relaxed", stmt.proposed_strictness);
check("statement: count_mode = 0", stmt.count_mode === 0);

// Mixed: 10 bills, 7 with 2 files (invoice + PO) → strict via multi_share ≥ .7.
const mixed = learnAttachmentConvention(
  Array.from({ length: 10 }, (_, i) => ({
    documents: i < 7 ? [pdf(`inv${i}.pdf`), pdf(`PO_${i}.pdf`)] : [pdf(`inv${i}.pdf`)],
  })),
);
check("mixed: multi_share = 0.7", mixed.multi_share === 0.7, mixed.multi_share);
check("mixed: proposed strict", mixed.proposed_strictness === "strict", mixed.proposed_strictness);
check("mixed: 'po' recurring (7/10 ≥ 50%)", mixed.recurring_name_tokens.includes("po"));

// Mostly single with occasional extra (2 of 20) → standard, not strict.
const occasional = learnAttachmentConvention(
  Array.from({ length: 20 }, (_, i) => ({
    documents: i < 2 ? [pdf(`a${i}.pdf`), pdf(`extra${i}.pdf`)] : [pdf(`a${i}.pdf`)],
  })),
);
check("occasional extra: proposed standard", occasional.proposed_strictness === "standard", occasional.proposed_strictness);

// Thin: 2 bills → standard with 'not enough history' rationale.
const thin = learnAttachmentConvention([{ documents: [] }, { documents: [pdf("x.pdf")] }]);
check("thin: standard (below MIN_ATTACH_SAMPLE)", thin.proposed_strictness === "standard" && /not enough/.test(thin.rationale), `n=2 < ${MIN_ATTACH_SAMPLE}`);
check("thin: confidence low", thin.confidence < 0.3, thin.confidence);

// File type inferred from name when file_type missing; images counted.
const types = learnAttachmentConvention([
  { documents: [{ file_name: "scan.JPG", file_type: null }] },
  { documents: [{ file_name: "scan2.jpg", file_type: "" }] },
  { documents: [pdf("i.pdf")] },
  { documents: [pdf("j.pdf")] },
]);
check("types: jpg inferred from name (2 of 4 docs)", types.types.jpg === 0.5, JSON.stringify(types.types));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
