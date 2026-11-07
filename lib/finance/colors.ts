import type { AreaVariant, DitherColor } from "@/components/dither-kit";

export type CategoryStyle = { color: DitherColor; variant: AreaVariant };

/**
 * Category → colour + fill variant, in one place. Only seven colours exist,
 * so the variant disambiguates: no two categories share colour AND variant.
 * Red is deliberately absent — it's reserved for over-budget/negative UI.
 * Semantics: green = savings/positive, blue = cash/mobility,
 * purple = investments/tech, orange = reserves/everyday/health, pink = lifestyle,
 * grey = neutral/pass-through/unknown.
 */
const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  Lohn: { color: "green", variant: "solid" },
  "Rückerstattungen": { color: "green", variant: "dotted" },
  Notgroschen: { color: "green", variant: "gradient" },
  "ETF IBKR": { color: "purple", variant: "gradient" },
  Steuern: { color: "orange", variant: "dotted" },
  Krankenkasse: { color: "orange", variant: "solid" },
  "Gesundheit/Franchise": { color: "orange", variant: "gradient" },
  "ÖV/Mobilität": { color: "blue", variant: "gradient" },
  Gym: { color: "pink", variant: "gradient" },
  "Technik/Abos": { color: "purple", variant: "hatched" },
  Reisen: { color: "blue", variant: "hatched" },
  "Jahreskosten/Diverses": { color: "purple", variant: "solid" },
  "Essen/Alltag": { color: "orange", variant: "hatched" },
  "Freizeit/Shopping": { color: "pink", variant: "dotted" },
  Puffer: { color: "grey", variant: "dotted" },
  Bildung: { color: "blue", variant: "solid" },
  Spesen: { color: "grey", variant: "gradient" },
  Unkategorisiert: { color: "grey", variant: "solid" },
};

export function categoryStyle(category: string): CategoryStyle {
  return CATEGORY_STYLES[category] ?? { color: "grey", variant: "hatched" };
}

export function categoryColor(category: string): DitherColor {
  return categoryStyle(category).color;
}

export function categoryVariant(category: string): AreaVariant {
  return categoryStyle(category).variant;
}

/** ChartConfig for a list of keys → labels/colours (dither-kit contract). */
export function chartConfigFor(
  keys: { key: string; label?: string; color?: DitherColor }[]
) {
  const config: Record<string, { label?: string; color: DitherColor }> = {};
  for (const { key, label, color } of keys) {
    config[key] = { label, color: color ?? categoryColor(key) };
  }
  return config;
}
