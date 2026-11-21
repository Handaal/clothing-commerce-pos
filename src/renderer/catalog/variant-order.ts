/**
 * Presentation-only ordering for variant lists. The API returns variants in creation order, so sizes
 * can surface as "S, L, M, XL". This sorts known apparel sizes (XXS…5XL) and numeric sizes (28, 30,
 * 32…) into the order a cashier expects; anything unrecognised keeps its original relative order after
 * the recognised ones. Same rule as the Storefront's picker. It never filters or changes variants.
 */
const LETTER_SIZES = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL"];
const ALIASES: Record<string, string> = {
  "2XS": "XXS",
  "3XS": "XXXS",
  "2XL": "XXL",
  "3XL": "XXXL",
  SMALL: "S",
  MEDIUM: "M",
  LARGE: "L",
  "EXTRA SMALL": "XS",
  "EXTRA LARGE": "XL",
};

/** Rank for a label ("M", "Navy / M", "M · Navy", "32"): letter sizes 0–10, numeric 100+, else null. */
export function sizeRank(label: string): number | null {
  const normalized = label.trim().toUpperCase();
  const tokens = normalized.split(/[\s/,|·•–-]+/u).filter(Boolean);
  for (const candidate of [normalized, ...tokens]) {
    const letter = ALIASES[candidate] ?? candidate;
    const index = LETTER_SIZES.indexOf(letter);
    if (index !== -1) return index;
  }
  for (const token of tokens) {
    if (/^\d+(\.\d+)?$/u.test(token)) return 100 + Number.parseFloat(token);
  }
  return null;
}

export function sortBySize<T>(items: readonly T[], label: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, rank: sizeRank(label(item)) }))
    .sort((a, b) => {
      if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank !== null && b.rank === null) return -1;
      if (a.rank === null && b.rank !== null) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}
