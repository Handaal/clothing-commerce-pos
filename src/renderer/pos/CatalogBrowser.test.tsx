// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SellableProduct } from "../catalog/catalog";
import { I18nProvider } from "../shell/i18n";
import { CatalogBrowser } from "./CatalogBrowser";

function product(
  id: string,
  name: string,
  categories: string[],
  prices: number[],
): SellableProduct {
  return {
    productId: id,
    productName: name,
    styleCode: null,
    brandId: "brand-1",
    brandName: null,
    categories,
    variants: prices.map((unitPriceMinor, index) => ({
      variantId: `${id}-v${index}`,
      productId: id,
      productName: name,
      variantName: `Size ${index}`,
      sku: `${id.toUpperCase()}-${index}`,
      barcode: `62200${id.length}${index}`,
      unitPriceMinor,
    })),
  };
}

const PRODUCTS = [
  product("tee", "Foundation Tee", ["Shirts"], [45000]),
  product("jacket", "Denim Jacket", ["Jackets"], [120000, 135000]),
  product("sock", "Plain Sock", [], [5000]),
];

function renderBrowser(overrides: Partial<Parameters<typeof CatalogBrowser>[0]> = {}) {
  const onScanMatch = vi.fn();
  const onSelectProduct = vi.fn();
  render(
    <I18nProvider>
      <button type="button">Elsewhere</button>
      <CatalogBrowser
        products={PRODUCTS}
        stockByVariant={new Map()}
        selectedProductId={null}
        onSelectProduct={onSelectProduct}
        onScanMatch={onScanMatch}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { onScanMatch, onSelectProduct, search: screen.getByRole("textbox") };
}

describe("CatalogBrowser", () => {
  afterEach(cleanup);

  it("shows every product with its price (or starting price) under the All chip", () => {
    renderBrowser();
    expect(screen.getByRole("button", { name: /All/, pressed: true })).toBeTruthy();
    const jacket = screen.getByRole("button", { name: /Denim Jacket/ });
    expect(jacket.textContent).toMatch(/From .*1,200/);
    expect(screen.getByRole("button", { name: /Foundation Tee/ }).textContent).toMatch(/450/);
    expect(screen.getByRole("button", { name: /Plain Sock/ })).toBeTruthy();
  });

  it("narrows the grid with one tap on a category chip", () => {
    renderBrowser();
    fireEvent.click(screen.getByRole("button", { name: /Jackets/ }));
    expect(screen.getByRole("button", { name: /Jackets/, pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Denim Jacket/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Foundation Tee/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Uncategorized/ }));
    expect(screen.getByRole("button", { name: /Plain Sock/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Denim Jacket/ })).toBeNull();
  });

  it("adds an exact SKU or barcode scan straight to the cart and clears the search", () => {
    const { onScanMatch, onSelectProduct, search } = renderBrowser();
    fireEvent.change(search, { target: { value: "jacket-1" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onScanMatch).toHaveBeenCalledWith(expect.objectContaining({ variantId: "jacket-v1" }));
    expect(onSelectProduct).not.toHaveBeenCalled();
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("routes keystrokes typed while focus is elsewhere into the search box", () => {
    const { search } = renderBrowser();
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "T" });
    expect((search as HTMLInputElement).value).toBe("T");
    expect(document.activeElement).toBe(search);
  });

  it("does not capture keystrokes while capture is off", () => {
    const { search } = renderBrowser({ captureKeys: false });
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "T" });
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("marks sold-out products and keeps unknown stock sellable", () => {
    renderBrowser({ stockByVariant: new Map([["tee-v0", 0]]) });
    const tee = screen.getByRole("button", { name: /Foundation Tee/ }) as HTMLButtonElement;
    expect(tee.disabled).toBe(true);
    expect(tee.textContent).toMatch(/Out of stock/);
    expect((screen.getByRole("button", { name: /Plain Sock/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("CatalogBrowser shortcuts", () => {
  afterEach(cleanup);

  it("focuses the search box on F2", () => {
    const { search } = renderBrowser();
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    fireEvent.keyDown(window, { key: "F2" });
    expect(document.activeElement).toBe(search);
  });
});
