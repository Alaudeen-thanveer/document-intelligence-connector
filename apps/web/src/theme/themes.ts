/**
 * The palette, as two halves of one design.
 *
 * Ground is Mist — a green-grey half white, never a flat white, so a screen
 * full of ledger rows does not glare. Accent is Forest.
 *
 * Because the accent is green, "success" cannot also be plain green or the
 * two stop being tellable apart (they measured 6 degrees of hue apart), so
 * success is a teal-green a clear 23 degrees off the accent.
 *
 * Every text pair here clears WCAG AA (4.5:1) against every surface it can
 * land on, including the selection tint — that last one is easy to forget
 * and is where the dark theme failed first.
 */

export const THEME_VAR_KEYS = [
  "bg",
  "bg-panel",
  "bg-panel-2",
  "bg-input",
  "border",
  "border-soft",
  "border-strong",
  "accent",
  "accent-2",
  "accent-soft",
  "accent-dim",
  "text",
  "text-dim",
  "text-faint",
  "ok",
  "ok-soft",
  "warn",
  "warn-soft",
  "warn-border",
  "danger",
  "danger-soft",
  "on-accent",
  "rule",
] as const;

export type ThemeVarKey = (typeof THEME_VAR_KEYS)[number];
export type ThemeVars = Record<ThemeVarKey, string>;
export type ThemeGroup = "light" | "dark";

export interface ThemeDefinition {
  label: string;
  group: ThemeGroup;
  vars: ThemeVars;
}

export const THEMES = {
  chalk: {
    label: "Light",
    group: "light",
    vars: {
      bg: "#eaeeea",
      "bg-panel": "#f5f8f5",
      "bg-panel-2": "#dfe5df",
      "bg-input": "#fbfcfb",
      border: "#d2dad2",
      "border-soft": "#e3e9e3",
      "border-strong": "#bac4ba",
      accent: "#256b45",
      "accent-2": "#1e5738",
      "accent-soft": "#d8ebdf",
      "accent-dim": "#b9dbc7",
      text: "#151a16",
      "text-dim": "#525c54",
      "text-faint": "#575f58",
      ok: "#0c6b5c",
      "ok-soft": "#d3ebe5",
      warn: "#8a5a0b",
      "warn-soft": "#f4ebd6",
      "warn-border": "#d9b978",
      danger: "#a33a2e",
      "danger-soft": "#f6e3dd",
      "on-accent": "#ffffff",
      rule: "rgba(21, 26, 22, 0.09)",
    },
  },
  ink: {
    label: "Dark",
    group: "dark",
    vars: {
      bg: "#151815",
      "bg-panel": "#1d211d",
      "bg-panel-2": "#101310",
      "bg-input": "#242923",
      border: "#2c332c",
      "border-soft": "#232823",
      "border-strong": "#3f493f",
      accent: "#6fc493",
      "accent-2": "#a5dcbb",
      "accent-soft": "#0f3421",
      "accent-dim": "#1b4f35",
      text: "#e6eae6",
      "text-dim": "#9fa99f",
      "text-faint": "#929c92",
      ok: "#46c4ac",
      "ok-soft": "#0c2b26",
      warn: "#d5a24b",
      "warn-soft": "#33280f",
      "warn-border": "#5a4a22",
      danger: "#de7b6c",
      "danger-soft": "#361c18",
      "on-accent": "#0a2416",
      rule: "rgba(230, 234, 230, 0.10)",
    },
  },
} as const satisfies Record<string, ThemeDefinition>;

export type ThemeKey = keyof typeof THEMES;

export const DEFAULT_THEME: ThemeKey = "chalk";

export function isThemeKey(value: string | null): value is ThemeKey {
  return value != null && value in THEMES;
}
