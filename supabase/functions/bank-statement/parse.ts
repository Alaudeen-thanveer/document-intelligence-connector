/**
 * Bank layer 2: turn whatever a bank hands over into dated lines.
 * Pure — no I/O.
 *
 * Banks do not agree on anything: column names, date formats, whether a
 * withdrawal is a negative amount, a separate column, a "DR" suffix or a
 * bracketed figure. This parser takes delimited text (CSV, TSV, or a table
 * pasted from a PDF/email) and returns normalised lines:
 *
 *   { txn_date, value_date, description, reference, side, amount, balance }
 *
 * where side is "debit" (money out) or "credit" (money in) and amount is
 * always positive. Rows it cannot make sense of are reported, not dropped
 * silently — the reviewer sees what was skipped.
 */

export interface ParsedLine {
  line_no: number;
  txn_date: string; // yyyy-mm-dd
  value_date: string | null;
  description: string;
  reference: string | null;
  side: "debit" | "credit";
  amount: number;
  balance: number | null;
}

export interface ParseResult {
  lines: ParsedLine[];
  /** Rows that were not usable, with why. */
  skipped: Array<{ row: number; reason: string; text: string }>;
  /** Which columns were recognised — for the reviewer's confidence. */
  columns: Record<string, number | null>;
  delimiter: string;
}

// ---------------------------------------------------------------------------
// Delimited text → cells
// ---------------------------------------------------------------------------

/**
 * Pick the delimiter that yields the most consistent column count.
 * Candidates: comma, tab, semicolon, pipe, and runs of 2+ spaces (a table
 * pasted from a PDF or email). Thousands separators inside amounts make
 * comma look plausible on pasted tables, so all candidates compete on the
 * same score — how many rows agree on the modal column count, then width.
 */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 25);
  let best = ",", bestScore = -1;
  for (const d of [",", "\t", ";", "|", "  "]) {
    const counts = sample.map((l) => splitRow(l, d).length);
    const multi = counts.filter((c) => c > 1);
    if (multi.length < Math.max(1, sample.length / 2)) continue;
    const freq = new Map<number, number>();
    for (const c of multi) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = multi[0], modeN = 0;
    for (const [c, n] of freq) if (n > modeN || (n === modeN && c > mode)) { mode = c; modeN = n; }
    const score = modeN * 10 + mode;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/**
 * Whitespace tables lose empty cells when split, so a data row with an
 * empty Credit collapses to one cell fewer and every later column shifts.
 * Align by character position instead: each token goes to the header
 * column whose span it overlaps most (numbers are usually right-aligned
 * under their header, text left-aligned — overlap handles both).
 */
export function alignByHeader(line: string, headerLine: string): string[] {
  const spans: Array<{ start: number; end: number }> = [];
  const re = /\S+(?: \S+)*/g; // tokens joined by single spaces
  let m: RegExpExecArray | null;
  while ((m = re.exec(headerLine))) spans.push({ start: m.index, end: m.index + m[0].length });
  if (!spans.length) return line.trim().split(/\s{2,}/);
  // Extend each header span to the midpoint between it and its neighbours.
  const bounds = spans.map((s, i) => ({
    lo: i === 0 ? 0 : Math.floor((spans[i - 1].end + s.start) / 2),
    hi: i === spans.length - 1 ? Number.MAX_SAFE_INTEGER : Math.floor((s.end + spans[i + 1].start) / 2),
  }));
  const cells = new Array<string>(spans.length).fill("");
  const tre = /\S+(?: \S+)*/g;
  while ((m = tre.exec(line))) {
    const ts = m.index, te = m.index + m[0].length;
    let best = 0, bestOverlap = -1;
    bounds.forEach((b, i) => {
      const overlap = Math.min(te, b.hi) - Math.max(ts, b.lo);
      if (overlap > bestOverlap) { bestOverlap = overlap; best = i; }
    });
    cells[best] = cells[best] ? `${cells[best]} ${m[0]}` : m[0];
  }
  return cells.map((c) => c.trim());
}

/** RFC-4180-ish split honouring quotes; "  " means runs of whitespace. */
export function splitRow(line: string, delimiter: string): string[] {
  if (delimiter === "  ") return line.trim().split(/\s{2,}/);
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delimiter && !inQ) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

// ---------------------------------------------------------------------------
// Header recognition
// ---------------------------------------------------------------------------

type Col = "date" | "value_date" | "description" | "reference" | "debit" | "credit" | "amount" | "balance";

const HEADER_HINTS: Record<Col, RegExp[]> = {
  value_date: [/value\s*date/i, /^val\.?\s*date/i, /^valdate$/i],
  date: [/^(txn|trans(action)?|posting|post|booking|book|entry)?\s*date$/i, /^date$/i, /^dt$/i, /transaction\s*date/i, /posting\s*date/i],
  description: [/descr/i, /narrat/i, /particular/i, /detail/i, /remark/i, /memo/i, /^transaction$/i, /payee|name/i],
  reference: [/^ref/i, /reference/i, /cheque\s*(no|number)?/i, /chq/i, /^utr/i, /^doc(ument)?\s*(no|number)/i],
  debit: [/^debit/i, /withdraw/i, /^dr\.?$/i, /money\s*out/i, /paid\s*out/i, /^out$/i, /payments?$/i],
  credit: [/^credit/i, /deposit/i, /^cr\.?$/i, /money\s*in/i, /paid\s*in/i, /^in$/i, /receipts?$/i],
  amount: [/^amount/i, /^amt/i, /^value$/i, /^sum$/i],
  balance: [/balance/i, /^bal/i, /running/i, /closing/i],
};

function matchHeader(cell: string): Col | null {
  const c = cell.replace(/[\s_()./-]+/g, " ").trim();
  if (!c) return null;
  // Order matters: "value date" before "date"; "debit amount" is debit, not amount.
  for (const col of ["value_date", "date", "debit", "credit", "balance", "amount", "reference", "description"] as Col[]) {
    if (HEADER_HINTS[col].some((re) => re.test(c))) return col;
  }
  return null;
}

/** Find the header row (first row where ≥2 cells look like known headers). */
export function detectHeader(rows: string[][]): { index: number; columns: Record<Col, number | null> } | null {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cols: Record<Col, number | null> = { date: null, value_date: null, description: null, reference: null, debit: null, credit: null, amount: null, balance: null };
    let hits = 0;
    rows[i].forEach((cell, idx) => {
      const col = matchHeader(cell);
      if (col && cols[col] == null) { cols[col] = idx; hits++; }
    });
    if (hits >= 2 && cols.date != null && (cols.amount != null || cols.debit != null || cols.credit != null)) {
      return { index: i, columns: cols };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/**
 * dd/mm/yyyy · dd-mm-yy · yyyy-mm-dd · dd MMM yyyy · dd-MMM-yy · MMM dd, yyyy.
 * Day-first is assumed for numeric ambiguity (UAE/UK/India banks); a
 * caller can flip that with `monthFirst`.
 */
export function parseDate(cell: string, monthFirst = false): string | null {
  const s = cell.trim().replace(/\s+/g, " ");
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]+(\d{2,4})/);
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; return mo ? iso(year(m[3]), mo, +m[1]) : null; }
  m = s.match(/^([A-Za-z]{3,9})[-/. ]+(\d{1,2})[-/. ,]+(\d{2,4})/);
  if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; return mo ? iso(year(m[3]), mo, +m[2]) : null; }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const a = +m[1], b = +m[2], y = year(m[3]);
    if (a > 12 && b <= 12) return iso(y, b, a);
    if (b > 12 && a <= 12) return iso(y, a, b);
    return monthFirst ? iso(y, a, b) : iso(y, b, a);
  }
  return null;
}
function year(y: string): number { const n = +y; return y.length === 2 ? 2000 + n : n; }
function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * "1,234.56" · "-1,234.56" · "(1,234.56)" · "1234.56 DR" · "AED 1,234.56"
 * · "1.234,56" (EU) → { value, sign } where sign is -1 for explicit
 * negatives/DR/brackets, +1 for CR or plain, 0 if unparseable.
 */
export function parseAmount(cell: string): { value: number; sign: -1 | 1 } | null {
  let s = cell.trim();
  if (!s || /^-+$/.test(s)) return null;
  let sign: -1 | 1 = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\bDR\b|\bDEBIT\b/i.test(s)) sign = -1;
  s = s.replace(/\b(CR|DR|DEBIT|CREDIT)\b/gi, "");
  s = s.replace(/[A-Za-z]{3}\.?/g, ""); // currency codes
  s = s.replace(/[^\d.,\-+]/g, "");
  if (s.startsWith("-")) { sign = -1; s = s.slice(1); }
  if (s.startsWith("+")) s = s.slice(1);
  if (!s) return null;
  // EU style "1.234,56" → last separator is the decimal mark
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return { value: Math.abs(n), sign };
}

// ---------------------------------------------------------------------------
// Whole statement
// ---------------------------------------------------------------------------

export function parseStatementText(text: string, opts: { monthFirst?: boolean } = {}): ParseResult {
  const delimiter = detectDelimiter(text);
  const rawRows = text.split(/\r?\n/).map((l) => l.replace(/ /g, " ")).filter((l) => l.trim());
  let rows = rawRows.map((l) => splitRow(l, delimiter));
  const header = detectHeader(rows);
  // Whitespace tables: re-split data rows by the header's column positions
  // so an empty cell does not shift everything after it.
  if (header && delimiter === "  ") {
    const headerLine = rawRows[header.index];
    rows = rawRows.map((l, i) => (i <= header.index ? rows[i] : alignByHeader(l, headerLine)));
  }
  const skipped: ParseResult["skipped"] = [];
  const lines: ParsedLine[] = [];

  // No header: fall back to positional guessing — date first, description
  // next, amounts by shape from the right.
  const cols: Record<Col, number | null> = header?.columns ?? {
    date: 0, value_date: null, description: 1, reference: null, debit: null, credit: null, amount: null, balance: null,
  };
  const start = header ? header.index + 1 : 0;

  for (let r = start; r < rows.length; r++) {
    const cells = rows[r];
    const rowNo = r + 1;
    const raw = rawRows[r];
    if (cells.every((c) => !c)) continue;
    const dateCell = cols.date != null ? cells[cols.date] ?? "" : cells[0] ?? "";
    const txnDate = parseDate(dateCell, opts.monthFirst);
    if (!txnDate) {
      // Multi-line descriptions: append to the previous line.
      if (lines.length && !header && cells.length <= 2) {
        lines[lines.length - 1].description += " " + cells.join(" ").trim();
        continue;
      }
      if (/total|opening|closing|balance b\/f|brought forward|carried forward/i.test(raw)) {
        skipped.push({ row: rowNo, reason: "summary row", text: raw.slice(0, 120) });
      } else {
        skipped.push({ row: rowNo, reason: "no date", text: raw.slice(0, 120) });
      }
      continue;
    }

    let side: "debit" | "credit" | null = null;
    let amount: number | null = null;
    if (cols.debit != null || cols.credit != null) {
      const d = cols.debit != null ? parseAmount(cells[cols.debit] ?? "") : null;
      const c = cols.credit != null ? parseAmount(cells[cols.credit] ?? "") : null;
      if (d && d.value > 0 && (!c || c.value === 0)) { side = "debit"; amount = d.value; }
      else if (c && c.value > 0 && (!d || d.value === 0)) { side = "credit"; amount = c.value; }
      else if (d && c && d.value > 0 && c.value > 0) {
        skipped.push({ row: rowNo, reason: "both debit and credit", text: raw.slice(0, 120) });
        continue;
      }
    }
    if (side == null && cols.amount != null) {
      const a = parseAmount(cells[cols.amount] ?? "");
      if (a && a.value > 0) { side = a.sign < 0 ? "debit" : "credit"; amount = a.value; }
    }
    if (side == null && !header) {
      // Positional: rightmost numeric cells are amount (and maybe balance).
      const nums = cells.map((c, i) => ({ i, a: parseAmount(c) })).filter((x) => x.a && x.a.value >= 0 && i_isNumericish(cells[x.i]));
      if (nums.length >= 1) {
        const pick = nums.length >= 2 ? nums[nums.length - 2] : nums[nums.length - 1];
        side = pick.a!.sign < 0 ? "debit" : "credit";
        amount = pick.a!.value;
        if (nums.length >= 2) cols.balance = nums[nums.length - 1].i;
      }
    }
    if (side == null || amount == null || amount === 0) {
      skipped.push({ row: rowNo, reason: "no amount", text: raw.slice(0, 120) });
      continue;
    }

    const descIdx = cols.description;
    let description = descIdx != null ? (cells[descIdx] ?? "") : "";
    if (!description) {
      // Take the longest non-numeric, non-date cell.
      description = cells
        .filter((c, i) => i !== cols.date && i !== cols.value_date && !parseAmount(c) && !parseDate(c))
        .sort((a, b) => b.length - a.length)[0] ?? "";
    }
    const reference = cols.reference != null ? (cells[cols.reference] || null) : null;
    const valueDate = cols.value_date != null ? parseDate(cells[cols.value_date] ?? "", opts.monthFirst) : null;
    const bal = cols.balance != null ? parseAmount(cells[cols.balance] ?? "") : null;

    lines.push({
      line_no: lines.length + 1,
      txn_date: txnDate,
      value_date: valueDate,
      description: description.replace(/\s+/g, " ").trim(),
      reference: reference ? reference.trim() : null,
      side,
      amount: Math.round(amount * 100) / 100,
      balance: bal ? Math.round(bal.value * bal.sign * 100) / 100 : null,
    });
  }

  return {
    lines,
    skipped,
    columns: cols,
    delimiter: delimiter === "  " ? "whitespace" : delimiter === "\t" ? "tab" : delimiter,
  };
}

function i_isNumericish(cell: string): boolean {
  return /\d/.test(cell) && !/[A-Za-z]{4,}/.test(cell.replace(/\b(CR|DR|AED|USD|EUR|GBP|INR|SAR)\b/gi, ""));
}

/**
 * Lines a bank statement PDF was reduced to by the vision model arrive as
 * loose objects; normalise them through the same rules so PDF and CSV
 * produce identical output.
 */
export function normalizeModelRows(
  rows: Array<Record<string, unknown>>,
  opts: { monthFirst?: boolean } = {},
): ParseResult {
  const lines: ParsedLine[] = [];
  const skipped: ParseResult["skipped"] = [];
  rows.forEach((row, i) => {
    const txnDate = parseDate(String(row.date ?? row.txn_date ?? ""), opts.monthFirst);
    if (!txnDate) { skipped.push({ row: i + 1, reason: "no date", text: JSON.stringify(row).slice(0, 120) }); return; }
    const debit = row.debit != null && String(row.debit) !== "" ? parseAmount(String(row.debit)) : null;
    const credit = row.credit != null && String(row.credit) !== "" ? parseAmount(String(row.credit)) : null;
    let side: "debit" | "credit" | null = null, amount: number | null = null;
    if (debit && debit.value > 0) { side = "debit"; amount = debit.value; }
    else if (credit && credit.value > 0) { side = "credit"; amount = credit.value; }
    else if (row.amount != null) {
      const a = parseAmount(String(row.amount));
      if (a && a.value > 0) { side = a.sign < 0 ? "debit" : "credit"; amount = a.value; }
    }
    if (!side || !amount) { skipped.push({ row: i + 1, reason: "no amount", text: JSON.stringify(row).slice(0, 120) }); return; }
    const bal = row.balance != null && String(row.balance) !== "" ? parseAmount(String(row.balance)) : null;
    lines.push({
      line_no: lines.length + 1,
      txn_date: txnDate,
      value_date: row.value_date ? parseDate(String(row.value_date), opts.monthFirst) : null,
      description: String(row.description ?? "").replace(/\s+/g, " ").trim(),
      reference: row.reference ? String(row.reference).trim() : null,
      side,
      amount: Math.round(amount * 100) / 100,
      balance: bal ? Math.round(bal.value * bal.sign * 100) / 100 : null,
    });
  });
  return { lines, skipped, columns: {}, delimiter: "model" };
}
