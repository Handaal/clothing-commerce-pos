import type { InventoryLocation, TenantCommerceClient } from "@shifted/clothing-commerce-sdk";
import { useEffect, useMemo, useState } from "react";

import { classifyCommerceError } from "../commerce/errors";
import { BUSINESS_CURRENCY, parseMajorToMinor } from "../money";
import { useI18n } from "../shell/i18n";
import { Select } from "../shell/Select";
import { useModalA11y } from "../shell/useModalA11y";

// Mirrors the elder POS "Add product" modal, adapted to the new API's create→variant→price→receive
// pipeline. The cashier names the product, picks a brand and a single selling price, then toggles the
// sizes they stock and types the opening quantity for each. A product with no sizes falls back to one
// "Standard" variant. Everything is created active and the opening stock is received into the chosen
// location so the item is immediately sellable at the register.

const APPAREL_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];
const SHOE_SIZES = ["36", "37", "38", "39", "40", "41", "42", "43", "44"];

interface Brand {
  id: string;
  displayName: string;
}

interface Category {
  id: string;
  name: string;
}

// SKU-safe token: uppercase alphanumerics and dashes only.
function token(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function AddProductModal({
  client,
  locations,
  defaultLocationId,
  onClose,
  onCreated,
}: {
  client: TenantCommerceClient;
  locations: readonly InventoryLocation[];
  defaultLocationId: string | null;
  onClose: () => void;
  // `warning` is set when the product was created successfully but a non-critical follow-up (listing it
  // online) failed, so the desk can surface it without treating the whole creation as a failure.
  onCreated: (productName: string, warning?: string) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);

  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [brandId, setBrandId] = useState("");
  const [newBrand, setNewBrand] = useState("");
  const [addingBrand, setAddingBrand] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [addingCategory, setAddingCategory] = useState(false);
  const [styleCode, setStyleCode] = useState("");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [locationId, setLocationId] = useState(defaultLocationId ?? "");
  const [publish, setPublish] = useState(false);

  const [apparel, setApparel] = useState(APPAREL_SIZES);
  const [shoes, setShoes] = useState(SHOE_SIZES);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, string>>({});
  const [standardQty, setStandardQty] = useState("");
  const [customSize, setCustomSize] = useState("");

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .listBrands({ status: "active", limit: 100 })
      .then((response) => {
        if (!active) return;
        const items = response.items.map((b) => ({ id: b.id, displayName: b.displayName }));
        setBrands(items);
        setBrandId((current) => current || items[0]?.id || "");
      })
      .catch((err) => active && setError(classifyCommerceError(err).message));
    return () => {
      active = false;
    };
  }, [client]);

  // Categories are the API's tenant-wide collections; the cashier picks one or creates a new one
  // inline. Classification is optional, so a product may be created with no category.
  useEffect(() => {
    let active = true;
    void client
      .listCollections()
      .then((response) => {
        if (!active) return;
        setCategories(
          response.collections
            .filter((c) => c.status !== "archived")
            .map((c) => ({ id: c.id, name: c.name })),
        );
      })
      .catch((err) => active && setError(classifyCommerceError(err).message));
    return () => {
      active = false;
    };
  }, [client]);

  // Brands are the tenant's labels (Zara, Bershka, …). The shop owner picks one or registers a new one
  // inline; it persists for every future product. The code is a SKU-safe token derived from the name,
  // suffixed for uniqueness so two brands with similar names never collide.
  async function addBrand() {
    const label = newBrand.trim();
    if (label === "") return setError(t("inventory.add.err.brandName"));
    setError(null);
    setAddingBrand(true);
    try {
      const code = `${token(label) || "BRAND"}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
      const created = await client.createBrand({
        idempotencyKey: crypto.randomUUID(),
        code,
        displayName: label,
      });
      // A newly created brand may start inactive; activate it so it classifies sellable stock.
      if (created.status !== "active") {
        await client.updateBrand({
          idempotencyKey: crypto.randomUUID(),
          brandId: created.id,
          status: "active",
        });
      }
      setBrands((current) => [...current, { id: created.id, displayName: label }]);
      setBrandId(created.id);
      setNewBrand("");
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setAddingBrand(false);
    }
  }

  async function addCategory() {
    const label = newCategory.trim();
    if (label === "") return setError(t("inventory.add.err.category"));
    setError(null);
    setAddingCategory(true);
    try {
      const slug = `${slugify(label) || "category"}-${Date.now().toString(36).slice(-4)}`;
      const created = await client.createCollection({
        idempotencyKey: crypto.randomUUID(),
        name: label,
        slug,
      });
      // Newly created collections start as draft; activate so they classify active stock.
      if (created.status !== "active") {
        await client.setCollectionStatus({
          idempotencyKey: crypto.randomUUID(),
          collectionId: created.collectionId,
          status: "active",
        });
      }
      setCategories((current) => [...current, { id: created.collectionId, name: label }]);
      setCategoryId(created.collectionId);
      setNewCategory("");
    } catch (err) {
      setError(classifyCommerceError(err).message);
    } finally {
      setAddingCategory(false);
    }
  }

  const chosenSizes = useMemo(
    () => [...apparel, ...shoes].filter((size) => enabled[size]),
    [apparel, shoes, enabled],
  );
  const hasVariants = chosenSizes.length > 0;
  const totalUnits = hasVariants
    ? chosenSizes.reduce((sum, size) => sum + (parseInt(qty[size] ?? "", 10) || 0), 0)
    : parseInt(standardQty, 10) || 0;

  const skuBase = token(styleCode) || token(name) || "ITEM";

  function toggle(size: string) {
    setEnabled((current) => ({ ...current, [size]: !current[size] }));
    setQty((current) => ({ ...current, [size]: current[size] ?? "0" }));
  }

  function addCustomSize() {
    const size = customSize.trim().toUpperCase();
    if (!size) return;
    const isShoe = /^\d+([.,]\d+)?$/.test(size);
    const column = isShoe ? shoes : apparel;
    const setColumn = isShoe ? setShoes : setApparel;
    if (!column.some((s) => s.toUpperCase() === size)) setColumn([...column, size]);
    setEnabled((current) => ({ ...current, [size]: true }));
    setQty((current) => ({ ...current, [size]: current[size] ?? "0" }));
    setCustomSize("");
  }

  async function submit() {
    setError(null);
    if (name.trim() === "") return setError(t("inventory.add.err.name"));
    if (brandId === "") return setError(t("inventory.add.err.brand"));
    const amountMinor = parseMajorToMinor(price);
    if (amountMinor === null || amountMinor <= 0) return setError(t("inventory.add.err.price"));
    // Unit cost is optional; when supplied it must be a valid non-negative amount.
    const costMinor = cost.trim() === "" ? null : parseMajorToMinor(cost);
    if (cost.trim() !== "" && (costMinor === null || costMinor < 0)) {
      return setError(t("inventory.add.err.price"));
    }
    if (!hasVariants && (parseInt(standardQty, 10) || 0) < 0) {
      return setError(t("inventory.err.qtyPositive"));
    }
    if (totalUnits > 0 && locationId === "") return setError(t("inventory.add.err.location"));

    // Each selected size (or a single "Standard") becomes one variant with its opening stock.
    const variants = hasVariants
      ? chosenSizes.map((size) => ({
          label: size,
          sku: `${skuBase}-${token(size)}`,
          quantity: Math.max(0, parseInt(qty[size] ?? "0", 10) || 0),
        }))
      : [{ label: null, sku: skuBase, quantity: Math.max(0, parseInt(standardQty, 10) || 0) }];

    setBusy(true);
    try {
      setProgress(t("inventory.add.progress.product"));
      const slug = `${slugify(name) || "product"}-${Date.now().toString(36).slice(-4)}`;
      const created = await client.createProduct({
        idempotencyKey: crypto.randomUUID(),
        brandId,
        name: name.trim(),
        slug,
        ...(styleCode.trim() ? { styleCode: styleCode.trim() } : {}),
      });
      const productId = created.productId;
      // Newly created products start as draft; activate so the register can sell them.
      if (created.status !== "active") {
        await client.setProductStatus({
          idempotencyKey: crypto.randomUUID(),
          productId,
          status: "active",
        });
      }

      for (const variant of variants) {
        setProgress(t("inventory.add.progress.variant", { sku: variant.sku }));
        const createdVariant = await client.createVariant({
          idempotencyKey: crypto.randomUUID(),
          productId,
          sku: variant.sku,
          ...(variant.label ? { displayName: variant.label } : {}),
        });
        await client.setVariantPrice({
          idempotencyKey: crypto.randomUUID(),
          variantId: createdVariant.variantId,
          currency: BUSINESS_CURRENCY,
          amountMinor,
        });
        if (costMinor !== null) {
          await client.setVariantCost({
            idempotencyKey: crypto.randomUUID(),
            variantId: createdVariant.variantId,
            unitCostMinor: costMinor,
          });
        }
        if (variant.quantity > 0) {
          await client.receiveInventory({
            idempotencyKey: crypto.randomUUID(),
            variantId: createdVariant.variantId,
            inventoryLocationId: locationId,
            quantity: variant.quantity,
          });
        }
      }

      if (categoryId) {
        setProgress(t("inventory.add.progress.category"));
        // setCollectionProducts replaces the whole membership set, so read the current members and
        // append this product rather than overwriting the collection.
        const detail = await client.getCollection(categoryId);
        if (!detail.productIds.includes(productId)) {
          await client.setCollectionProducts({
            idempotencyKey: crypto.randomUUID(),
            collectionId: categoryId,
            productIds: [...detail.productIds, productId],
          });
        }
      }

      // The product is already created, priced and stocked at this point. Listing it online is a
      // secondary step with its own server-side preconditions (storefront settings, eligibility), so a
      // failure here must NOT present as a total failure — otherwise the operator re-submits and creates
      // a duplicate product. Surface it as a warning instead and let the creation stand.
      let publishWarning: string | undefined;
      if (publish) {
        setProgress(t("inventory.add.progress.publish"));
        try {
          await client.publishProduct({ idempotencyKey: crypto.randomUUID(), productId });
        } catch (publishErr) {
          console.error("[AddProduct] online listing failed", publishErr);
          publishWarning = t("inventory.add.err.publish", {
            reason: classifyCommerceError(publishErr).message,
          });
        }
      }

      onCreated(name.trim(), publishWarning);
    } catch (err) {
      console.error("[AddProduct] failed", err);
      setError(classifyCommerceError(err).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const columns: { key: string; title: string; sizes: string[] }[] = [
    { key: "apparel", title: t("inventory.add.clothingSizes"), sizes: apparel },
    { key: "shoes", title: t("inventory.add.shoeSizes"), sizes: shoes },
  ];

  return (
    <div className="staff-modal__scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="staff-modal add-product-modal"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t("inventory.add.title")}</h3>
        <div className="staff-modal__body">
          <label className="field">
            {t("inventory.add.name")}
            <input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="add-product-grid2">
            <label className="field">
              {t("inventory.add.brand")}
              <Select
                ariaLabel={t("inventory.add.brand")}
                placeholder={t("inventory.add.chooseBrand")}
                value={brandId}
                onChange={setBrandId}
                disabled={brands.length === 0}
                options={brands.map((b) => ({ value: b.id, label: b.displayName }))}
              />
            </label>
            <div className="field">
              {t("inventory.add.newBrand")}
              <div className="add-product-custom">
                <input
                  value={newBrand}
                  onChange={(e) => setNewBrand(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addBrand();
                    }
                  }}
                />
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={addingBrand || newBrand.trim() === ""}
                  onClick={() => void addBrand()}
                >
                  {t("inventory.add.addBrand")}
                </button>
              </div>
            </div>
          </div>

          <label className="field">
            {t("inventory.add.styleCode")}
            <input value={styleCode} onChange={(e) => setStyleCode(e.target.value)} />
          </label>

          <div className="add-product-grid2">
            <label className="field">
              {t("inventory.add.category")}
              <Select
                ariaLabel={t("inventory.add.category")}
                placeholder={t("inventory.add.chooseCategory")}
                value={categoryId}
                onChange={setCategoryId}
                options={[
                  { value: "", label: t("inventory.add.chooseCategory") },
                  ...categories.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            </label>
            <div className="field">
              {t("inventory.add.newCategory")}
              <div className="add-product-custom">
                <input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addCategory();
                    }
                  }}
                />
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={addingCategory || newCategory.trim() === ""}
                  onClick={() => void addCategory()}
                >
                  {t("inventory.add.addCategory")}
                </button>
              </div>
            </div>
          </div>

          <div className="add-product-grid2">
            <label className="field">
              {t("inventory.add.price")}
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <label className="field">
              {t("inventory.add.cost")}
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </label>
          </div>

          <label className="field">
            {t("inventory.add.receiveInto")}
            <Select
              ariaLabel={t("inventory.add.receiveInto")}
              placeholder={t("inventory.chooseDestination")}
              value={locationId}
              onChange={setLocationId}
              disabled={locations.length === 0}
              options={locations.map((loc) => ({ value: loc.id, label: loc.displayName }))}
            />
          </label>

          <p className="field__label">{t("inventory.add.sizes")}</p>
          <div className="add-product-sizes">
            {columns.map((column) => (
              <div className="add-product-size-col" key={column.key}>
                <p className="add-product-size-col__title">{column.title}</p>
                {column.sizes.map((size) => (
                  <div className="add-product-size-row" key={size}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!enabled[size]}
                        onChange={() => toggle(size)}
                      />
                      <span>{size}</span>
                    </label>
                    {enabled[size] ? (
                      <input
                        className="add-product-size-qty"
                        inputMode="numeric"
                        aria-label={t("inventory.add.qtyFor", { size })}
                        value={qty[size] ?? "0"}
                        onChange={(e) => setQty((c) => ({ ...c, [size]: e.target.value }))}
                      />
                    ) : (
                      <span />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="add-product-custom">
            <input
              placeholder={t("inventory.add.customSize")}
              value={customSize}
              onChange={(e) => setCustomSize(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomSize();
                }
              }}
            />
            <button type="button" className="button button--quiet" onClick={addCustomSize}>
              {t("cashier.add")}
            </button>
          </div>

          {!hasVariants ? (
            <label className="field">
              {t("inventory.add.standardQty")}
              <input
                inputMode="numeric"
                placeholder="0"
                value={standardQty}
                onChange={(e) => setStandardQty(e.target.value)}
              />
            </label>
          ) : (
            <p className="muted">{t("inventory.add.totalUnits", { count: totalUnits })}</p>
          )}

          <label className="add-product-publish">
            <input
              type="checkbox"
              checked={publish}
              onChange={(e) => setPublish(e.target.checked)}
            />
            <span>{t("inventory.add.publish")}</span>
          </label>

          {progress ? (
            <p className="inline-state" role="status">
              {progress}
            </p>
          ) : null}
          {error ? (
            <div className="notice notice--error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <div className="staff-modal__actions">
          <button className="button button--quiet" onClick={onClose} disabled={busy}>
            {t("pay.cancel")}
          </button>
          <button className="button" onClick={() => void submit()} disabled={busy}>
            {busy ? t("inventory.add.creating") : t("inventory.add.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
