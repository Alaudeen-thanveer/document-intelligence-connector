import { useTheme } from "../theme/ThemeProvider";

/**
 * Light and dark. Lifted out of AppLayout so the new chrome and the settings
 * drawer can both reach it without either owning it.
 */
export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "ink";
  return (
    <button
      type="button"
      className={`mode-toggle${isDark ? " dark" : ""}`}
      aria-pressed={isDark}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "chalk" : "ink")}
    >
      <span className="mode-toggle-switch" aria-hidden="true" />
      <span>{isDark ? "Dark" : "Light"}</span>
    </button>
  );
}
