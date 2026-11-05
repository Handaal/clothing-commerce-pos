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

// Per-device display size, applied as the frame's zoom factor (like the browser's Ctrl +/−) so the
// whole UI shrinks to fit a cramped 14" laptop or enlarges on a roomy 16" screen. It belongs to the
// machine, not the business, so it is kept in localStorage and never synced.
export type UiScale = "compact" | "normal" | "large";
const SCALE_FACTOR: Record<UiScale, number> = { compact: 0.85, normal: 1, large: 1.15 };

interface ThemeValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
  palette: PaletteId;
  setPalette: (palette: PaletteId) => void;
  scale: UiScale;
  setScale: (scale: UiScale) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);
const STORAGE_KEY = "pos.theme";
const PALETTE_KEY = "pos.palette";
const SCALE_KEY = "pos.scale";

function initialScale(): UiScale {
  if (typeof window === "undefined") return "normal";
  const stored = window.localStorage.getItem(SCALE_KEY);
  return stored === "compact" || stored === "large" ? stored : "normal";
}

function applyScale(scale: UiScale): void {
  if (typeof window === "undefined") return;
  window.view?.setZoom(SCALE_FACTOR[scale]);
}

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
  const [scale, setScaleState] = useState<UiScale>(initialScale);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    applyPalette(palette);
    if (typeof window !== "undefined") window.localStorage.setItem(PALETTE_KEY, palette);
  }, [palette]);

  // Re-assert the saved display size on mount (and whenever it changes), so a reload keeps the scale.
  useEffect(() => {
    applyScale(scale);
    if (typeof window !== "undefined") window.localStorage.setItem(SCALE_KEY, scale);
  }, [scale]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggle = useCallback(() => setThemeState((t) => (t === "light" ? "dark" : "light")), []);
  const setPalette = useCallback((next: PaletteId) => setPaletteState(next), []);
  const setScale = useCallback((next: UiScale) => setScaleState(next), []);

  const value = useMemo<ThemeValue>(
    () => ({ theme, setTheme, toggle, palette, setPalette, scale, setScale }),
    [theme, setTheme, toggle, palette, setPalette, scale, setScale],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}
