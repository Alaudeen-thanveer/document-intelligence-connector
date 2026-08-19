/**
 * Zoho bank rules accuracy check: the org's rules as evidence on statement
 * lines, and learned patterns proposed AS Zoho rules (recognize mode only).
 * Usage: node --experimental-strip-types scripts/bank-zoho-rules-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { ruleApplies, suggestFromZohoRules, kindForRecordAs, isProposableAsZohoRule, zohoRuleBodyForPattern, RULE_PROPOSAL_MIN_SAMPLES } =
  await import(pathToFileURL(resolve(root, "supabase/functions/bank-statement/zoho_rules.ts")).href);
const { suggestForLines } = await import(pathToFileURL(resolve(root, "supabase/functions/bank-statement/suggest.ts")).href);
let failures = 0;
function check(name, cond, detail = "") { const ok = Boolean(cond); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; }

const rule = { rule_id: "R1", rule_name: "T1 Etisalat → Telephone", rule_category: "all_banks", apply_to: "withdrawals", criteria_type: "and",
  criterion: [{ field: "description", comparator: "contains", value: "ETISALAT" }], record_as: "expense", account_id: "ACC-TEL", account_name: "Telephone Expense", vendor_id: "V-ETI", auto_categorize: "recognize", is_active: true };
const line = (o = {}) => ({ description: "POS ETISALAT UAE 0501234567", reference: "REF1", payee: null, side: "debit", amount: 210, ...o });

console.log("— rule applies? —");
check("contains on description, withdrawal side", ruleApplies(line(), rule, "B1"));
check("wrong side (deposit) → no", !ruleApplies(line({ side: "credit" }), rule, "B1"));
check("inactive rule → no", !ruleApplies(line(), { ...rule, is_active: false }, "B1"));
check("selected_accounts scope respected", !ruleApplies(line(), { ...rule, rule_category: "selected_accounts", account_ids: "B9,B8" }, "B1") && ruleApplies(line(), { ...rule, rule_category: "selected_accounts", account_ids: ["B1"] }, "B1"));
check("criteria 'and' needs every criterion", !ruleApplies(line(), { ...rule, criterion: [...rule.criterion, { field: "amount", comparator: "greater_than", value: 500 }] }, "B1"));
check("criteria 'or' needs one", ruleApplies(line(), { ...rule, criteria_type: "or", criterion: [{ field: "description", comparator: "contains", value: "NOPE" }, { field: "amount", comparator: "less_than", value: 500 }] }, "B1"));
check("payee and reference fields", ruleApplies(line({ payee: "Etisalat" }), { ...rule, criterion: [{ field: "payee", comparator: "is", value: "etisalat" }] }, "B1") && ruleApplies(line(), { ...rule, criterion: [{ field: "reference_number", comparator: "starts_with", value: "REF" }] }, "B1"));
check("no criteria → never applies", !ruleApplies(line(), { ...rule, criterion: [] }, "B1"));

console.log("\n— suggestion from a rule —");
let s = suggestFromZohoRules(line(), [rule], "B1");
check("expense to Telephone, vendor from rule, source zoho_rule, 0.9 recognize", s && s.txn_kind === "expense" && s.account_id === "ACC-TEL" && s.party_kind === "vendor" && s.party_zoho_id === "V-ETI" && s.source === "zoho_rule" && s.confidence === 0.9, JSON.stringify(s));
check("autocategorize rule → 0.95 and says so", suggestFromZohoRules(line(), [{ ...rule, auto_categorize: "autocategorize" }], "B1").confidence === 0.95 && /auto-categorise/.test(suggestFromZohoRules(line(), [{ ...rule, auto_categorize: "autocategorize" }], "B1").reason));
check("no rule applies → null", suggestFromZohoRules(line({ description: "ATM CASH" }), [rule], "B1") === null);
check("record_as mapping: transfer_fund→transfer, interest_income→deposit, owner_drawings→other, card_payment→expense", kindForRecordAs("transfer_fund") === "transfer" && kindForRecordAs("interest_income") === "deposit" && kindForRecordAs("owner_drawings") === "other" && kindForRecordAs("card_payment") === "expense");

console.log("\n— engine order: open documents beat rules, rules beat learned patterns —");
const ctx = { patterns: [{ fingerprint: "ETISALAT", tokens: ["ETISALAT"], side: "debit", txn_kind: "expense", account_id: "ACC-OTHER", account_name: "Other", party_kind: null, party_zoho_id: null, party_name: null, confidence: 0.8, sample_size: 5, share: 1, examples: [] }],
  parties: [{ kind: "vendor", zoho_id: "V-ETI", name: "Etisalat" }], openDocs: [], openCredits: [], recorded: [], policies: { already_recorded_window_days: 3, bank_charge_tolerance: { AED: 5 }, writeoff_after_days: null, writeoff_max_amount: null }, currency: "AED", today: "2026-08-19",
  zohoRules: [rule], bankAccountId: "B1", payees: {} };
let out = suggestForLines([{ line_no: 1, txn_date: "2026-08-10", description: "POS ETISALAT UAE 0501234567", reference: "REF1", side: "debit", amount: 210 }], ctx);
check("rule wins over the learned pattern (explicit habit > inferred)", out[0]?.source === "zoho_rule" && out[0].account_id === "ACC-TEL", JSON.stringify(out[0]));
out = suggestForLines([{ line_no: 1, txn_date: "2026-08-10", description: "POS ETISALAT UAE 0501234567", reference: "REF1", side: "debit", amount: 210 }], { ...ctx, zohoRules: [], parties: [] });
check("without rules the learned pattern answers", out[0]?.source === "learned" && out[0].account_id === "ACC-OTHER", JSON.stringify(out[0]));
out = suggestForLines([{ line_no: 1, txn_date: "2026-08-10", description: "TRF ETISALAT BILL 0042", reference: "REF2", side: "debit", amount: 210 }], { ...ctx, openDocs: [{ kind: "bill", zoho_id: "BILL42", number: "BILL-0042", party_zoho_id: "V-ETI", party_name: "Etisalat", date: "2026-08-01", due_date: null, balance: 210, total: 210, currency: "AED" }] });
check("an open bill for the same vendor and amount beats the rule (payment, not expense)", out[0]?.source === "open_document" && out[0].txn_kind === "vendor_payment", JSON.stringify(out[0]));
check("rule vendor name resolved from parties", suggestForLines([{ line_no: 1, txn_date: "2026-08-10", description: "POS ETISALAT", reference: null, side: "debit", amount: 1 }], ctx)[0].party_name === "Etisalat");

console.log("\n— proposing a learned pattern as a Zoho rule —");
const strong = { fingerprint: "ADCB CHARGES", tokens: ["ADCB", "CHARGES"], side: "debit", txn_kind: "expense", account_id: "ACC-BANKCH", account_name: "Bank Charges", party_kind: null, party_zoho_id: null, party_name: null, confidence: 0.96, sample_size: 14, share: 1, examples: ["ADCB CHARGES MONTHLY"] };
check("strong expense pattern is proposable", isProposableAsZohoRule(strong).ok);
check("weak confidence not", !isProposableAsZohoRule({ ...strong, confidence: 0.85 }).ok);
check(`below ${RULE_PROPOSAL_MIN_SAMPLES} samples not`, /samples/.test(isProposableAsZohoRule({ ...strong, sample_size: 11 }).why));
check("payment kinds never (a rule cannot know the allocation)", /cannot record a vendor payment/.test(isProposableAsZohoRule({ ...strong, txn_kind: "vendor_payment" }).why));
check("already proposed / dismissed not", !isProposableAsZohoRule({ ...strong, zoho_rule_id: "R9" }).ok && !isProposableAsZohoRule({ ...strong, suggestion_status: "dismissed" }).ok);
const body = zohoRuleBodyForPattern(strong);
check("body: recognize mode, withdrawals, description contains each token, expense to the account", body.auto_categorize === "recognize" && body.apply_to === "withdrawals" && body.criterion.length === 2 && body.criterion.every((c) => c.field === "description" && c.comparator === "contains") && body.record_as === "expense" && body.account_id === "ACC-BANKCH" && body.rule_category === "all_banks", JSON.stringify(body));
check("body never autocategorizes", JSON.stringify(zohoRuleBodyForPattern({ ...strong, txn_kind: "deposit", side: "credit" })).indexOf("autocategorize") === -1 && zohoRuleBodyForPattern({ ...strong, txn_kind: "deposit", side: "credit" }).apply_to === "deposits");
check("scoped to selected accounts when asked", zohoRuleBodyForPattern(strong, { bankAccountIds: ["B1"] }).rule_category === "selected_accounts" && zohoRuleBodyForPattern(strong, { bankAccountIds: ["B1"] }).account_ids === "B1");
check("vendor carried when learned", zohoRuleBodyForPattern({ ...strong, party_kind: "vendor", party_zoho_id: "V1" }).vendor_id === "V1");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);
