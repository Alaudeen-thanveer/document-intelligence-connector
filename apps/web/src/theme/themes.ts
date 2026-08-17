/** Chalk = pics 1–2 (cool white + emerald). Ink = pics 3–4 (indigo + violet). */

export const THEME_VAR_KEYS = [
  "bg",
  "bg-panel",
  "bg-panel-2",
  "bg-input",
  "border",
  "border-soft",
  "accent",
  "accent-2",
  "accent-soft",
  "accent-dim",
  "text",
  "text-dim",
  "text-faint",
  "warn",
  "warn-soft",
  "warn-border",
  "on-accent",
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
      bg: "#f8f9f8",
      "bg-panel": "#ffffff",
      "bg-panel-2": "#f3f4f3",
      "bg-input": "#ffffff",
      border: "#e5e7eb",
      "border-soft": "#eef0ee",
      accent: "#10b981",
      "accent-2": "#059669",
      "accent-soft": "#d1fae5",
      "accent-dim": "#a7f3d0",
      text: "#111827",
      "text-dim": "#4b5563",
      "text-faint": "#9ca3af",
      warn: "#f97316",
      "warn-soft": "#fff7ed",
      "warn-border": "#fdba74",
      "on-accent": "#ffffff",
    },
  },
  ink: {
    label: "Dark",
    group: "dark",
    vars: {
      bg: "#0c0c1a",
      "bg-panel": "#161625",
      "bg-panel-2": "#1c1c32",
      "bg-input": "#12122a",
      border: "#2a2a4a",
      "border-soft": "#22223c",
      accent: "#7c7cfc",
      "accent-2": "#5b5bd6",
      "accent-soft": "#24244a",
      "accent-dim": "#32326a",
      text: "#f4f2ff",
      "text-dim": "#a8a3c9",
      "text-faint": "#6e6a93",
      warn: "#f59e0b",
      "warn-soft": "#3a2a12",
      "warn-border": "#6b4e1c",
      "on-accent": "#0a0620",
    },
  },
} as const satisfies Record<string, ThemeDefinition>;

export type ThemeKey = keyof typeof THEMES;

export const DEFAULT_THEME: ThemeKey = "chalk";

export function isThemeKey(value: string | null): value is ThemeKey {
  return value != null && value in THEMES;
}
