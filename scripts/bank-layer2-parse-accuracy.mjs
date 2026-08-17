/**
 * Bank layer 2 accuracy check: statement text → normalised lines, across
 * the shapes banks actually produce.
 * Usage: node --experimental-strip-types scripts/bank-layer2-parse-accuracy.mjs
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { parseStatementText, parseDate, parseAmount, detectDelimiter, normalizeModelRows } =
  await import(pathToFileURL(resolve(root, "supabase/functions/bank-statement/parse.ts")).href);

let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

console.log("— dates —");
check("dd/mm/yyyy", parseDate("12/08/2026") === "2026-08-12");
check("dd-mm-yy", parseDate("05-08-26") === "2026-08-05");
check("yyyy-mm-dd", parseDate("2026-08-12") === "2026-08-12");
check("dd MMM yyyy", parseDate("12 Aug 2026") === "2026-08-12");
check("dd-MMM-yy", parseDate("03-Sep-26") === "2026-09-03");
check("MMM dd, yyyy", parseDate("Aug 12, 2026") === "2026-08-12");
check("unambiguous numeric resolves regardless of monthFirst", parseDate("25/08/2026", true) === "2026-08-25");
check("ambiguous numeric honours monthFirst", parseDate("08/05/2026", true) === "2026-08-05" && parseDate("08/05/2026") === "2026-05-08");
check("garbage → null", parseDate("Opening balance") === null);

console.log("\n— amounts —");
check("1,234.56", JSON.stringify(parseAmount("1,234.56")) === JSON.stringify({ value: 1234.56, sign: 1 }));
check("-1,234.56", JSON.stringify(parseAmount("-1,234.56")) === JSON.stringify({ value: 1234.56, sign: -1 }));
check("(1,234.56)", JSON.stringify(parseAmount("(1,234.56)")) === JSON.stringify({ value: 1234.56, sign: -1 }));
check("1234.56 DR", JSON.stringify(parseAmount("1234.56 DR")) === JSON.stringify({ value: 1234.56, sign: -1 }));
check("AED 52.50 CR", JSON.stringify(parseAmount("AED 52.50 CR")) === JSON.stringify({ value: 52.5, sign: 1 }));
check("EU 1.234,56", JSON.stringify(parseAmount("1.234,56")) === JSON.stringify({ value: 1234.56, sign: 1 }));
check("empty / dash → null", parseAmount("") === null && parseAmount("-") === null);

// ------------------------------------------------------------------ shape 1
console.log("\n— shape 1: UAE bank CSV, separate debit/credit, running balance —");
const enbd = `Account Statement,,,,,
Account No,0123456789,,,,
,,,,,
Transaction Date,Value Date,Description,Reference,Debit,Credit,Balance
01/08/2026,01/08/2026,SO TRF LANDLORD PROPERTIES LLC RENT 2026-08,SO7712,"4,200.00",,"152,340.10"
02/08/2026,02/08/2026,MONTHLY ACCOUNT MAINTENANCE FEE,,52.50,,"152,287.60"
04/08/2026,04/08/2026,POS PURCHASE ETISALAT 044556 DUBAI AE,,"1,148.00",,"151,139.60"
15/08/2026,15/08/2026,INWARD TT ACME RETAIL GRP REF 88213 VALUE DATE 15082026,TT88213,,"5,000.00","156,139.60"
16/08/2026,16/08/2026,CHQ 000456,000456,"2,100.00",,"154,039.60"
,,,,,,
,,Closing Balance,,,,"154,039.60"`;
const r1 = parseStatementText(enbd);
check("delimiter comma", r1.delimiter === ",");
check("header found; 5 lines parsed", r1.lines.length === 5, `${r1.lines.length} lines · skipped ${r1.skipped.map((s) => s.reason).join(",")}`);
check("closing-balance row skipped as a summary row (preamble before the header is simply not data)", r1.skipped.length === 1 && r1.skipped[0].reason === "summary row", JSON.stringify(r1.skipped));
check("line 1: debit 4200 on 2026-08-01, reference SO7712", r1.lines[0].side === "debit" && r1.lines[0].amount === 4200 && r1.lines[0].txn_date === "2026-08-01" && r1.lines[0].reference === "SO7712");
check("line 4: credit 5000, description intact", r1.lines[3].side === "credit" && r1.lines[3].amount === 5000 && r1.lines[3].description.startsWith("INWARD TT ACME"));
check("balance parsed with thousands separator", r1.lines[0].balance === 152340.1);
check("value date captured", r1.lines[0].value_date === "2026-08-01");

// ------------------------------------------------------------------ shape 2
console.log("\n— shape 2: single signed Amount column, dd-MMM-yy —");
const uk = `Date,Description,Amount,Balance
01-Aug-26,Standing order LANDLORD PROPERTIES,-4200.00,12000.00
04-Aug-26,CARD PAYMENT ETISALAT,-1148.00,10852.00
15-Aug-26,FASTER PAYMENT ACME RETAIL GROUP,5000.00,15852.00`;
const r2 = parseStatementText(uk);
check("3 lines; signs decide the side", r2.lines.length === 3 && r2.lines[0].side === "debit" && r2.lines[2].side === "credit");
check("amounts positive after normalisation", r2.lines.every((l) => l.amount > 0));
check("dd-MMM-yy dates", r2.lines[1].txn_date === "2026-08-04");

// ------------------------------------------------------------------ shape 3
console.log("\n— shape 3: EU export, semicolon, comma decimals, DR/CR suffix —");
const eu = `Buchungstag;Verwendungszweck;Betrag;Saldo
12.08.2026;ETISALAT ONLINE;1.148,00 DR;10.852,00
15.08.2026;ACME RETAIL GROUP;5.000,00 CR;15.852,00`;
const r3 = parseStatementText(eu);
check("semicolon detected", r3.delimiter === ";", r3.delimiter);
check("header via 'Betrag' (amount) + date-like first column", r3.lines.length === 2, `${r3.lines.length} lines · cols ${JSON.stringify(r3.columns)}`);
check("1.148,00 DR → debit 1148", r3.lines[0]?.side === "debit" && r3.lines[0]?.amount === 1148, r3.lines[0] && `${r3.lines[0].side} ${r3.lines[0].amount}`);
check("5.000,00 CR → credit 5000", r3.lines[1]?.side === "credit" && r3.lines[1]?.amount === 5000);

// ------------------------------------------------------------------ shape 4
console.log("\n— shape 4: table pasted from a PDF / email (whitespace columns) —");
const pasted = `Date          Description                                   Debit        Credit       Balance
01/08/2026    SO TRF LANDLORD PROPERTIES LLC RENT           4,200.00                  152,340.10
04/08/2026    POS PURCHASE ETISALAT 044556 DUBAI AE         1,148.00                  151,192.10
15/08/2026    INWARD TT ACME RETAIL GRP REF 88213                        5,000.00     156,192.10`;
const r4 = parseStatementText(pasted);
check("whitespace delimiter detected", r4.delimiter === "whitespace", r4.delimiter);
check("3 lines with correct sides", r4.lines.length === 3 && r4.lines[0].side === "debit" && r4.lines[2].side === "credit", `${r4.lines.length}`);
check("multi-word descriptions survive splitting on 2+ spaces", r4.lines[0].description === "SO TRF LANDLORD PROPERTIES LLC RENT", r4.lines[0]?.description);

// ------------------------------------------------------------------ shape 5
console.log("\n— shape 5: no header at all, positional —");
const bare = `12/08/2026,ETISALAT POS 044556,-1148.00,10852.00
15/08/2026,ACME RETAIL GRP,5000.00,15852.00`;
const r5 = parseStatementText(bare);
check("headerless CSV still yields 2 lines", r5.lines.length === 2, `${r5.lines.length}`);
check("second-from-right numeric is amount, rightmost is balance", r5.lines[0]?.amount === 1148 && r5.lines[0]?.side === "debit" && r5.lines[0]?.balance === 10852);

// ------------------------------------------------------------------ model rows
console.log("\n— PDF via vision model → same normalisation —");
const rm = normalizeModelRows([
  { date: "12 Aug 2026", description: "ETISALAT POS", debit: "1,148.00", credit: "", balance: "10,852.00" },
  { date: "15/08/2026", description: "ACME RETAIL GRP", amount: "5000", balance: "15,852.00" },
  { date: "n/a", description: "junk", amount: "" },
]);
check("2 good rows, 1 skipped with reason", rm.lines.length === 2 && rm.skipped.length === 1 && rm.skipped[0].reason === "no date");
check("debit column and signed amount both normalise", rm.lines[0].side === "debit" && rm.lines[1].side === "credit" && rm.lines[1].amount === 5000);

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
