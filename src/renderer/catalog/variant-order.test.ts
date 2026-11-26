import { describe, expect, it } from "vitest";

import { sizeRank, sortBySize } from "./variant-order";

describe("sortBySize", () => {
  it("orders letter and numeric sizes the way staff expect", () => {
    expect(sortBySize(["S", "L", "M", "XL"], (v) => v)).toEqual(["S", "M", "L", "XL"]);
    expect(sortBySize(["34", "30", "32"], (v) => v)).toEqual(["30", "32", "34"]);
    expect(sortBySize(["L · Navy", "S · Navy", "One size"], (v) => v)).toEqual([
      "S · Navy",
      "L · Navy",
      "One size",
    ]);
    expect(sizeRank("Navy / XXL")).toBe(7);
  });
});
