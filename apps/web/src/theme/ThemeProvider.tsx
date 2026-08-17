import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_THEME,
  isThemeKey,
  THEMES,
  type ThemeKey,
} from "./themes";

const STORAGE_KEY = "dic-theme";

interface ThemeContextValue {
  theme: ThemeKey;
  setTheme: (key: ThemeKey) => void;
  themes: typeof THEMES;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): ThemeKey {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isThemeKey(stored)) return stored;
  } catch {
    // private mode / blocked storage
  }
  // First visit: always chalk. Do not read prefers-color-scheme.
  return DEFAULT_THEME;
}

function applyThemeVars(key: ThemeKey): void {
  const theme = THEMES[key];
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.vars)) {
    root.style.setProperty(`--${name}`, value);
  }
  root.style.colorScheme = theme.group;
  root.dataset.theme = key;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeKey>(() => {
    const key = readStoredTheme();
    applyThemeVars(key);
    return key;
  });

  useEffect(() => {
    applyThemeVars(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: setThemeState,
      themes: THEMES,
    }),
    [theme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}
