// The fixed accent palettes an operator can choose in Settings → Appearance. A palette retints the
// whole theme (brand + neutral undertone) for BOTH light and dark modes. It is applied by toggling a
// `pal-<id>` class on <html>; the default "clay" palette carries no class and is the base identity in
// styles.css. Palettes compose with the `data-theme` attribute, so a chosen palette holds across a
// light/dark switch. These are device-local operator preferences, not tenant configuration.

export type PaletteId = "clay" | "indigo" | "noir";

export const DEFAULT_PALETTE: PaletteId = "clay";

export interface Palette {
  id: PaletteId;
  label: string;
  // Three representative chips for the picker preview: [accent, primary, surface tint].
  swatches: readonly [string, string, string];
}

// Fashionable but restrained — each reads as a boutique, not a cafe: earthy clay, denim indigo,
// monochrome noir with a brass accent. Swatch colors are the light-mode values so the picker previews
// what you get.
export const PALETTE_LIST: readonly Palette[] = [
  { id: "clay", label: "Clay", swatches: ["#a23f2d", "#26413a", "#efe8dc"] },
  { id: "indigo", label: "Indigo", swatches: ["#3f4f8f", "#2b3357", "#e4e7f1"] },
  { id: "noir", label: "Noir", swatches: ["#9a7b45", "#2b2a27", "#e7e4de"] },
];

/** Apply a palette by toggling its `pal-<id>` class on <html>. The default palette carries no class. */
export function applyPalette(id: PaletteId): void {
  if (typeof document === "undefined") return;
  const list = document.documentElement.classList;
  for (const palette of PALETTE_LIST) {
    if (palette.id !== DEFAULT_PALETTE) list.remove(`pal-${palette.id}`);
  }
  if (id !== DEFAULT_PALETTE) list.add(`pal-${id}`);
}

export function isPaletteId(value: string | null): value is PaletteId {
  return value !== null && PALETTE_LIST.some((palette) => palette.id === value);
}
