/**
 * Books hygiene — pure. The tidiness checks a reviewer runs before (or
 * after) closing, none of which change anything on their own:
 *
 *   • SUSPENSE / UNCATEGORISED BALANCES — accounts whose name says
 *     "suspense" or "uncategorised" (plus Zoho's Opening Balance
 *     Adjustments) carrying a non-zero balance at month-end. Money parked
 *     there is a question someone deferred; closing a period should
 *     answer it. Attention nudge.
 *   • DUPLICATE VENDORS / CUSTOMERS — two active contacts that normalise
 *     to the same name (legal suffixes like LLC/FZE/LTD stripped), or two
 *     contacts sharing one TRN. Splits history and makes every learned
 *     pattern weaker.
 *   • MISSING TRNs — VAT-registered contacts without a 15-digit TRN;
 *     Form 201 and the e-invoice both need it.
 *   • DUPLICATE ACCOUNTS — two active ledger accounts normalising to the
 *     same name; postings scatter between them.
 *   • UNUSED ACCOUNTS — user-created, active, zero balance; the caller
 *     confirms "no transactions ever" against Zoho before labelling one
 *     truly unused (a zero balance alone can just mean fully settled).
 *
 * Everything is listed with a plain-English note; a human tidies in Zoho.
 */

export interface HygieneAccount {
  account_id: string;
  account_name: string;
  account_type: string;
  current_balance: number;
  is_active: boolean;
  is_user_created: boolean;
  is_system_account: boolean;
}
export interface HygieneContact {
  zoho_id: string;
  name: string;
  kind: "vendor" | "customer";
  trn: string | null;
  tax_treatment: string | null;
  status: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const VAT_REGISTERED = new Set(["vat_registered", "dz_vat_registered", "gcc_vat_registered"]);
const LEGAL_SUFFIXES = ["LLC", "LLC.", "L.L.C", "L.L.C.", "FZE", "FZC", "FZ", "FZ-LLC", "LTD", "LTD.", "LIMITED", "INC", "INC.", "CO", "CO.", "COMPANY", "EST", "ESTABLISHMENT", "GENERAL TRADING", "TRADING"];

/** Contact-name normalisation: case/punctuation-blind, trailing legal suffixes stripped. */
export function normContactName(name: string): string {
  // Dots vanish BEFORE splitting so "L.L.C." reads as one word, not three.
  let words = name.toUpperCase().replace(/\./g, "").replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const sw = suffix.replace(/[^A-Z ]+/g, "").split(/\s+/).filter(Boolean);
      if (sw.length && words.length > sw.length && words.slice(-sw.length).join(" ") === sw.join(" ")) {
        words = words.slice(0, -sw.length);
        changed = true;
      }
    }
  }
  return words.join(" ");
}
const normAccountName = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, "");
const isValidTrn = (trn: string | null) => /^\d{15}$/.test(String(trn ?? "").replace(/\s/g, ""));

// ---------------------------------------------------------------------------
export interface SuspenseRow { account_id: string; account_name: string; balance: number; note: string }
export function findSuspenseBalances(accounts: HygieneAccount[]): SuspenseRow[] {
  const out: SuspenseRow[] = [];
  for (const a of accounts) {
    if (!a.is_active || Math.abs(a.current_balance) <= 0.005) continue;
    const suspense = /suspense|uncategori[sz]ed/i.test(a.account_name);
    const openingDump = /opening balance adjustment/i.test(a.account_name);
    if (!suspense && !openingDump) continue;
    out.push({
      account_id: a.account_id, account_name: a.account_name, balance: r2(a.current_balance),
      note: suspense
        ? `${a.account_name} holds ${r2(a.current_balance).toFixed(2)} — money parked there is a question someone deferred; move it to its real account before closing.`
        : `${a.account_name} holds ${r2(a.current_balance).toFixed(2)} — opening-balance leftovers that never found a home; worth clearing with the accountant.`,
    });
  }
  return out.sort((x, y) => Math.abs(y.balance) - Math.abs(x.balance));
}

// ---------------------------------------------------------------------------
export interface DuplicateGroup { kind: "vendor" | "customer"; reason: "name" | "trn"; names: string[]; ids: string[]; note: string }
export function findDuplicateContacts(contacts: HygieneContact[]): DuplicateGroup[] {
  const active = contacts.filter((c) => (c.status ?? "active") === "active");
  const out: DuplicateGroup[] = [];
  for (const kind of ["vendor", "customer"] as const) {
    const ofKind = active.filter((c) => c.kind === kind);
    const byName = new Map<string, HygieneContact[]>();
    for (const c of ofKind) {
      const key = normContactName(c.name);
      if (!key) continue;
      byName.set(key, [...(byName.get(key) ?? []), c]);
    }
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      out.push({ kind, reason: "name", names: group.map((c) => c.name), ids: group.map((c) => c.zoho_id), note: `${group.map((c) => `“${c.name}”`).join(" and ")} look like the same ${kind} — bills and history split between them; merge in Zoho Books (Contacts → … → Merge).` });
    }
    const byTrn = new Map<string, HygieneContact[]>();
    for (const c of ofKind) {
      if (!c.trn) continue;
      byTrn.set(c.trn, [...(byTrn.get(c.trn) ?? []), c]);
    }
    for (const group of byTrn.values()) {
      if (group.length < 2) continue;
      const names = new Set(group.map((c) => normContactName(c.name)));
      if (names.size < 2 && out.some((g) => g.reason === "name" && group.every((c) => g.ids.includes(c.zoho_id)))) continue; // already caught by name
      out.push({ kind, reason: "trn", names: group.map((c) => c.name), ids: group.map((c) => c.zoho_id), note: `${group.map((c) => `“${c.name}”`).join(" and ")} share TRN ${group[0].trn} — one registration cannot be two ${kind}s.` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
export interface MissingTrnRow { kind: "vendor" | "customer"; zoho_id: string; name: string; note: string }
export function findMissingTrns(contacts: HygieneContact[]): MissingTrnRow[] {
  return contacts
    .filter((c) => (c.status ?? "active") === "active" && VAT_REGISTERED.has(String(c.tax_treatment ?? "").toLowerCase()) && !isValidTrn(c.trn))
    .map((c) => ({
      kind: c.kind, zoho_id: c.zoho_id, name: c.name,
      note: c.trn
        ? `${c.name} is VAT-registered but the TRN on file (“${c.trn}”) is not 15 digits.`
        : `${c.name} is VAT-registered but has no TRN on the contact — Form 201 and the e-invoice both need it.`,
    }));
}

// ---------------------------------------------------------------------------
export interface DuplicateAccountGroup { names: string[]; ids: string[]; note: string }
export function findDuplicateAccounts(accounts: HygieneAccount[]): DuplicateAccountGroup[] {
  const byName = new Map<string, HygieneAccount[]>();
  for (const a of accounts) {
    if (!a.is_active) continue;
    const key = `${normAccountName(a.account_name)}`;
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), a]);
  }
  const out: DuplicateAccountGroup[] = [];
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    out.push({ names: group.map((a) => a.account_name), ids: group.map((a) => a.account_id), note: `${group.map((a) => `“${a.account_name}”`).join(" and ")} are the same ledger account twice — postings scatter between them; keep one and deactivate the other.` });
  }
  return out;
}

/** Zero-balance, user-created, active accounts — the caller confirms "no transactions" against Zoho. */
export function unusedAccountCandidates(accounts: HygieneAccount[]): HygieneAccount[] {
  return accounts.filter((a) => a.is_active && a.is_user_created && !a.is_system_account && Math.abs(a.current_balance) <= 0.005);
}
