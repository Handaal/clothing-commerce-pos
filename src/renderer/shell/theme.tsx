import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { applyPalette, DEFAULT_PALETTE, isPaletteId, type PaletteId } from "./palettes";

export type Theme = "light" | "dark";

interface ThemeValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
  palette: PaletteId;
  setPalette: (palette: PaletteId) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);
const STORAGE_KEY = "pos.theme";
const PALETTE_KEY = "pos.palette";

function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "dark" ? "dark" : "light";
}

function initialPalette(): PaletteId {
  if (typeof window === "undefined") return DEFAULT_PALETTE;
  const stored = window.localStorage.getItem(PALETTE_KEY);
  return isPaletteId(stored) ? stored : DEFAULT_PALETTE;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [palette, setPaletteState] = useState<PaletteId>(initialPalette);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    applyPalette(palette);
    if (typeof window !== "undefined") window.localStorage.setItem(PALETTE_KEY, palette);
  }, [palette]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggle = useCallback(() => setThemeState((t) => (t === "light" ? "dark" : "light")), []);
  const setPalette = useCallback((next: PaletteId) => setPaletteState(next), []);

  const value = useMemo<ThemeValue>(
    () => ({ theme, setTheme, toggle, palette, setPalette }),
    [theme, setTheme, toggle, palette, setPalette],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}
