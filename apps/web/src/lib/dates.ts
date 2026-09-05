/**
 * Dates that came out of a Postgres `date` column.
 *
 * PostgREST sends such a column as a bare "YYYY-MM-DD". `new Date("2026-07-04")`
 * reads that as UTC midnight, so anywhere west of UTC it renders as the day
 * before: an invoice dated the 4th shown as the 3rd. In a bookkeeping tool that
 * is not cosmetic — a date at the edge of a month decides which VAT period the
 * bill falls in.
 *
 * Timestamps (timestamptz) are a different thing and must NOT go through here:
 * they carry a real instant and should be converted to the reader's zone.
 */
const BARE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a value that may be a calendar date or a full timestamp. */
export function asLocalDate(value: string): Date {
  const m = BARE.exec(value);
  if (!m) return new Date(value);
  // Local midnight, so no zone shift can move the day.
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // new Date(26, ...) means 1926: the two-argument-plus form maps years 0-99
  // into the 1900s. A year like 0026 out of a bad read would then print as
  // "26" beside every real 2026 date and look right.
  d.setFullYear(Number(m[1]));
  return d;
}

/** Today, in the reader's own calendar — never the UTC day. */
export function todayLocalISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "19 Aug 26" — a calendar date, never shifted by the reader's zone. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = asLocalDate(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "2-digit",
  });
}

/** "19 Aug, 14:32" — an instant, correctly shown in the reader's zone. */
export function shortStamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
