/**
 * The one description of where the app can go.
 *
 * It used to live in three hand-synced places — the rail's RailLink calls,
 * the SECTIONS breadcrumb map, and the LEGACY_HASH table — and two of them
 * had already drifted: SECTIONS had no "/bank" key, so /bank rendered the
 * breadcrumb "Documents", and LEGACY_HASH had no "cash" entry.
 *
 * `group` says where a destination is reached from. The tab strip carries
 * the work; the settings drawer carries the things you set up once and then
 * only check on. Nothing here decides what the chrome looks like — it only
 * says what exists.
 */
export type NavGroup = "tab" | "drawer";

export interface NavItem {
  path: string;
  label: string;
  group: NavGroup;
  /** The old rail's glyph. Carried so the rail looks unchanged until it goes. */
  icon: string;
}

export const NAV: NavItem[] = [
  { path: "/", label: "Documents", group: "tab", icon: "▤" },
  { path: "/bank", label: "Banking", group: "tab", icon: "⌸" },
  { path: "/month-end", label: "Month-end", group: "tab", icon: "└" },
  { path: "/cash", label: "Cash", group: "tab", icon: "◈" },
  { path: "/rules", label: "Rules", group: "tab", icon: "§" },
  { path: "/connections", label: "Connections", group: "drawer", icon: "⇄" },
  { path: "/api-usage", label: "API usage", group: "drawer", icon: "▦" },
];

export const TABS = NAV.filter((n) => n.group === "tab");
export const DRAWER_LINKS = NAV.filter((n) => n.group === "drawer");

/** The name of the section a path belongs to, for the breadcrumb and the title. */
export function sectionFor(pathname: string): string {
  return NAV.find((n) => n.path === pathname)?.label ?? "Documents";
}

/**
 * Old hash tabs (#connections) to real paths. Derived from NAV so a new
 * destination cannot be forgotten here the way /cash was.
 */
export const LEGACY_HASH: Record<string, string> = Object.fromEntries(
  NAV.filter((n) => n.path !== "/").map((n) => [n.path.slice(1), n.path]),
);
