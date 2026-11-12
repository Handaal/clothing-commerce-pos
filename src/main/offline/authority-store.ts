import { randomUUID } from "node:crypto";

import type {
  OfflineBootstrapResponse,
  PosDeviceResponse,
} from "@shifted/clothing-commerce-sdk" with { "resolution-mode": "import" };

import { LocalDatabase } from "./database";
import type { PublicDeviceKey } from "./device-key";

export interface EnrollmentPreparation {
  readonly installationId: string;
  readonly publicKey: PublicDeviceKey;
  readonly idempotencyKey: string;
  readonly existingDevice:
    | {
        readonly deviceId: string;
        readonly credentialId: string;
        readonly status: "active";
      }
    | undefined;
}

export interface CacheInstallTestSeam {
  afterStage?(stage: "grant" | "catalog" | "inventory" | "before_activation"): void;
}

interface DeviceRow {
  tenant_id: string | null;
  device_id: string | null;
  credential_id: string | null;
  register_id: string | null;
  public_key_fingerprint: string;
  status: "pending" | "active" | "revoked";
  enrollment_idempotency_key: string;
  bootstrap_idempotency_key: string | null;
}

function requireIsoDate(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO date-time.`);
}

function requireSafeNonNegative(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
}

export class OfflineAuthorityStore {
  constructor(
    private readonly database: LocalDatabase,
    private readonly testSeam?: CacheInstallTestSeam,
  ) {}

  prepareEnrollment(
    tenantId: string,
    registerId: string,
    publicKey: PublicDeviceKey,
    now: string,
  ): EnrollmentPreparation {
    const metadata = this.database.connection
      .prepare("SELECT installation_id FROM app_metadata WHERE singleton_id = 1")
      .get() as { installation_id: string };
    const current = this.database.connection
      .prepare(
        `SELECT tenant_id, device_id, credential_id, register_id, public_key_fingerprint,
          status, enrollment_idempotency_key, bootstrap_idempotency_key
         FROM device_state WHERE singleton_id = 1`,
      )
      .get() as DeviceRow | undefined;

    if (current) {
      if (
        current.tenant_id !== tenantId ||
        current.register_id !== registerId ||
        current.public_key_fingerprint !== publicKey.fingerprint
      ) {
        throw new Error("The local device identity is already bound to another enrollment.");
      }
      if (current.status === "revoked") throw new Error("The enrolled device is revoked.");
      return {
        installationId: metadata.installation_id,
        publicKey,
        idempotencyKey: current.enrollment_idempotency_key,
        existingDevice:
          current.status === "active" && current.device_id && current.credential_id
            ? {
                deviceId: current.device_id,
                credentialId: current.credential_id,
                status: "active",
              }
            : undefined,
      };
    }

    const idempotencyKey = randomUUID();
    this.database.connection
      .prepare(
        `INSERT INTO device_state(
          singleton_id, tenant_id, register_id, public_key_spki_base64,
          public_key_fingerprint, status, enrollment_idempotency_key, updated_at
        ) VALUES (1, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(tenantId, registerId, publicKey.value, publicKey.fingerprint, idempotencyKey, now);
    return {
      installationId: metadata.installation_id,
      publicKey,
      idempotencyKey,
      existingDevice: undefined,
    };
  }

  completeEnrollment(device: PosDeviceResponse, tenantId: string, now: string): void {
    const current = this.getDeviceRow();
    if (current.tenant_id !== tenantId || current.register_id !== device.registerId) {
      throw new Error("The server device enrollment does not match the pending local binding.");
    }
    this.database.connection
      .prepare(
        `UPDATE device_state SET device_id = ?, credential_id = ?, status = ?,
          activated_at = ?, revoked_at = ?, last_validated_at = ?, updated_at = ?
         WHERE singleton_id = 1`,
      )
      .run(
        device.deviceId,
        device.credentialId,
        device.status,
        device.activatedAt,
        device.revokedAt,
        now,
        now,
      );
  }

  prepareBootstrapIdempotencyKey(): string {
    const current = this.getDeviceRow();
    if (current.status !== "active" || !current.device_id || !current.credential_id) {
      throw new Error("An active enrolled device is required before offline bootstrap.");
    }
    if (current.bootstrap_idempotency_key) return current.bootstrap_idempotency_key;
    const key = randomUUID();
    this.database.connection
      .prepare(
        "UPDATE device_state SET bootstrap_idempotency_key = ?, updated_at = ? WHERE singleton_id = 1",
      )
      .run(key, new Date().toISOString());
    return key;
  }

  getActiveDevice(): {
    deviceId: string;
    credentialId: string;
    registerId: string;
    tenantId: string;
  } {
    const current = this.getDeviceRow();
    if (
      current.status !== "active" ||
      !current.device_id ||
      !current.credential_id ||
      !current.register_id ||
      !current.tenant_id
    ) {
      throw new Error("An active enrolled device is unavailable.");
    }
    return {
      deviceId: current.device_id,
      credentialId: current.credential_id,
      registerId: current.register_id,
      tenantId: current.tenant_id,
    };
  }

  installBootstrap(bootstrap: OfflineBootstrapResponse, observedAt: string): number {
    this.validateBootstrap(bootstrap);
    const current = this.getActiveDevice();
    if (
      current.tenantId !== bootstrap.tenantId ||
      current.deviceId !== bootstrap.deviceId ||
      current.registerId !== bootstrap.registerId
    ) {
      throw new Error("Offline bootstrap binding does not match the enrolled local device.");
    }
    const payload = JSON.stringify(bootstrap);
    return this.database.transaction(() => {
      this.database.connection
        .prepare(
          `INSERT INTO offline_grant(
            grant_id, snapshot_id, schema_version, minimum_client_version, tenant_id, device_id,
            register_id, branch_id, inventory_location_id, operator_membership_id, currency,
            issued_at, operator_expires_at, catalog_valid_until, accepted_until,
            max_sale_amount_minor, max_cumulative_exposure_minor, max_quantity_per_line,
            max_pending_offline_sales, max_offline_credit_exposure_minor, payload_json, installed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bootstrap.grantId,
          bootstrap.snapshotId,
          bootstrap.schemaVersion,
          bootstrap.minimumClientVersion,
          bootstrap.tenantId,
          bootstrap.deviceId,
          bootstrap.registerId,
          bootstrap.branchId,
          bootstrap.inventoryLocationId,
          bootstrap.operatorMembershipId,
          bootstrap.currency,
          bootstrap.issuedAt,
          bootstrap.operatorExpiresAt,
          bootstrap.catalogValidUntil,
          bootstrap.acceptedUntil,
          bootstrap.policy.maxSaleAmountMinor,
          bootstrap.policy.maxCumulativeExposureMinor,
          bootstrap.policy.maxQuantityPerLine,
          bootstrap.policy.maxPendingOfflineSales,
          bootstrap.policy.maxOfflineCreditExposureMinor ?? 0,
          payload,
          observedAt,
        );
      this.database.connection
        .prepare(
          `INSERT INTO context_snapshot(
            snapshot_id, tenant_id, register_id, branch_id, inventory_location_id,
            currency, payload_json, installed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bootstrap.snapshotId,
          bootstrap.tenantId,
          bootstrap.registerId,
          bootstrap.branchId,
          bootstrap.inventoryLocationId,
          bootstrap.currency,
          JSON.stringify({
            tenantId: bootstrap.tenantId,
            registerId: bootstrap.registerId,
            branchId: bootstrap.branchId,
            inventoryLocationId: bootstrap.inventoryLocationId,
            currency: bootstrap.currency,
          }),
          observedAt,
        );
      this.database.connection
        .prepare(
          `INSERT INTO catalog_snapshot(
            snapshot_id, grant_id, generated_at, valid_until, state, installed_at
          ) VALUES (?, ?, ?, ?, 'installing', ?)`,
        )
        .run(
          bootstrap.snapshotId,
          bootstrap.grantId,
          bootstrap.issuedAt,
          bootstrap.catalogValidUntil,
          observedAt,
        );
      this.testSeam?.afterStage?.("grant");

      const insertProduct = this.database.connection.prepare(
        `INSERT INTO catalog_product(snapshot_id, product_id, brand_id, name, active)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const insertVariant = this.database.connection.prepare(
        `INSERT INTO catalog_variant_price(
          snapshot_id, product_id, variant_id, sku, option_summary, active, currency,
          authorized_unit_price_minor, price_id, price_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertInventory = this.database.connection.prepare(
        `INSERT INTO inventory_snapshot(
          snapshot_id, inventory_location_id, variant_id, on_hand, version, as_of, valid_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const product of bootstrap.catalog) {
        insertProduct.run(
          bootstrap.snapshotId,
          product.productId,
          product.brandId,
          product.name,
          product.active ? 1 : 0,
        );
        for (const variant of product.variants) {
          insertVariant.run(
            bootstrap.snapshotId,
            product.productId,
            variant.variantId,
            variant.sku,
            variant.optionSummary,
            variant.active ? 1 : 0,
            bootstrap.currency,
            variant.authorizedUnitPriceMinor,
            variant.priceId,
            variant.priceVersion,
          );
          insertInventory.run(
            bootstrap.snapshotId,
            bootstrap.inventoryLocationId,
            variant.variantId,
            variant.advisoryInventory.onHandQuantity,
            variant.advisoryInventory.version,
            variant.advisoryInventory.asOf,
            bootstrap.catalogValidUntil,
          );
        }
      }
      this.testSeam?.afterStage?.("catalog");
      this.testSeam?.afterStage?.("inventory");
      this.installStaffRoster(bootstrap.snapshotId, bootstrap);
      this.installCustomers(bootstrap.snapshotId, bootstrap);
      this.installClassification(bootstrap.snapshotId, bootstrap);
      this.database.connection
        .prepare("UPDATE catalog_snapshot SET state = 'complete' WHERE snapshot_id = ?")
        .run(bootstrap.snapshotId);
      this.testSeam?.afterStage?.("before_activation");
      this.database.connection
        .prepare("UPDATE catalog_snapshot SET state = 'retired' WHERE state = 'active'")
        .run();
      this.database.connection
        .prepare("UPDATE catalog_snapshot SET state = 'active' WHERE snapshot_id = ?")
        .run(bootstrap.snapshotId);
      this.database.connection
        .prepare(
          `UPDATE device_state SET branch_id = ?, inventory_location_id = ?,
            bootstrap_idempotency_key = NULL, last_validated_at = ?, updated_at = ?
           WHERE singleton_id = 1`,
        )
        .run(bootstrap.branchId, bootstrap.inventoryLocationId, observedAt, observedAt);
      this.database.connection
        .prepare(
          `UPDATE app_metadata SET trusted_server_time = ?, trusted_local_time = ?
           WHERE singleton_id = 1`,
        )
        .run(bootstrap.issuedAt, observedAt);
      const released = this.database.connection
        .prepare(
          `UPDATE local_sale SET projection_released_at = ?
           WHERE lifecycle = 'synced' AND projection_released_at IS NULL
             AND server_received_at IS NOT NULL AND server_received_at <= ?`,
        )
        .run(observedAt, bootstrap.issuedAt);
      return Number(released.changes);
    });
  }

  /**
   * Install the authorized-staff roster delivered with the bootstrap, keyed to this snapshot so it
   * retires atomically with the catalog it was issued against. Forward-compatible: a bootstrap that
   * carries no `staffRoster` (an older server, or offline login not provisioned) installs nothing and
   * offline login simply stays unavailable. Each entry carries only a server-computed PIN verifier.
   * Runs inside the caller's bootstrap transaction, so an invalid entry rolls the whole install back.
   */
  private installStaffRoster(snapshotId: string, bootstrap: OfflineBootstrapResponse): void {
    const raw = (bootstrap as unknown as { staffRoster?: unknown }).staffRoster;
    if (raw === undefined || raw === null) return;
    if (!Array.isArray(raw)) throw new Error("The offline staff roster is not a list.");
    const insert = this.database.connection.prepare(
      `INSERT INTO staff_roster(
        snapshot_id, membership_id, username, display_name, pin_kdf, pin_salt_base64,
        pin_hash_base64, scrypt_n, scrypt_r, scrypt_p, key_length
      ) VALUES (?, ?, ?, ?, 'scrypt', ?, ?, ?, ?, ?, ?)`,
    );
    const usernames = new Set<string>();
    const memberships = new Set<string>();
    for (const value of raw) {
      const entry = this.validateStaffRosterEntry(value);
      if (memberships.has(entry.membershipId)) {
        throw new Error("Duplicate membership in offline staff roster.");
      }
      if (usernames.has(entry.username)) {
        throw new Error("Duplicate username in offline staff roster.");
      }
      memberships.add(entry.membershipId);
      usernames.add(entry.username);
      insert.run(
        snapshotId,
        entry.membershipId,
        entry.username,
        entry.displayName,
        entry.saltBase64,
        entry.hashBase64,
        entry.n,
        entry.r,
        entry.p,
        entry.keyLength,
      );
    }
  }

  /**
   * Install the customer snapshot delivered with the bootstrap, keyed to this snapshot so it retires
   * atomically with the catalog. Forward-compatible: a bootstrap that carries no `customers` (an older
   * server, or offline installments not provisioned) installs nothing and offline installments simply
   * stay unavailable. Runs inside the caller's transaction, so a bad entry rolls the whole install back.
   */
  private installCustomers(snapshotId: string, bootstrap: OfflineBootstrapResponse): void {
    const raw = (bootstrap as unknown as { customers?: unknown }).customers;
    if (raw === undefined || raw === null) return;
    if (!Array.isArray(raw)) throw new Error("The offline customer snapshot is not a list.");
    const insert = this.database.connection.prepare(
      `INSERT INTO catalog_customer(
        snapshot_id, customer_id, name, phone, snapshot_outstanding_minor
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    const ids = new Set<string>();
    for (const value of raw) {
      const entry = this.validateCustomerEntry(value);
      if (ids.has(entry.customerId)) {
        throw new Error("Duplicate customer in offline snapshot.");
      }
      ids.add(entry.customerId);
      insert.run(snapshotId, entry.customerId, entry.name, entry.phone, entry.outstandingMinor);
    }
  }

  /**
   * Install the server-authoritative display classification (brand name + category names) that the
   * offline bootstrap now carries per catalog product, keyed to this snapshot so it retires atomically
   * with the catalog. Backward compatible: a product from an older server simply has no brandName /
   * categories and installs as unclassified. Runs inside the caller's transaction. This is display
   * metadata only — it never participates in the offline sale path.
   */
  private installClassification(snapshotId: string, bootstrap: OfflineBootstrapResponse): void {
    const insert = this.database.connection.prepare(
      `INSERT OR IGNORE INTO catalog_classification(
        snapshot_id, product_id, brand_name, categories_json
      ) VALUES (?, ?, ?, ?)`,
    );
    for (const product of bootstrap.catalog) {
      const raw = product as unknown as {
        brandName?: unknown;
        categories?: unknown;
      };
      const brandName =
        typeof raw.brandName === "string" && raw.brandName.length > 0 ? raw.brandName : null;
      // The contract carries categories as [{ id, name }]; the offline cache stores names for the
      // register's category-first browse (ids are available in the snapshot if needed later).
      const categories = Array.isArray(raw.categories)
        ? raw.categories
            .map((c) => (c && typeof c === "object" ? (c as { name?: unknown }).name : undefined))
            .filter((name): name is string => typeof name === "string" && name.length > 0)
        : [];
      insert.run(snapshotId, product.productId, brandName, JSON.stringify(categories));
    }
  }

  private validateCustomerEntry(value: unknown): {
    customerId: string;
    name: string;
    phone: string;
    outstandingMinor: number;
  } {
    if (!value || typeof value !== "object")
      throw new Error("A customer snapshot entry is invalid.");
    const entry = value as Record<string, unknown>;
    const string = (candidate: unknown, field: string): string => {
      if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 400) {
        throw new Error(`Customer snapshot ${field} is invalid.`);
      }
      return candidate;
    };
    const customerId = string(entry.customerId, "customerId");
    const name = string(entry.name, "name");
    const phone = string(entry.phone, "phone");
    if (!Number.isSafeInteger(entry.outstandingMinor) || Number(entry.outstandingMinor) < 0) {
      throw new Error("Customer snapshot outstandingMinor is invalid.");
    }
    return { customerId, name, phone, outstandingMinor: Number(entry.outstandingMinor) };
  }

  private validateStaffRosterEntry(value: unknown): {
    membershipId: string;
    username: string;
    displayName: string;
    saltBase64: string;
    hashBase64: string;
    n: number;
    r: number;
    p: number;
    keyLength: number;
  } {
    if (!value || typeof value !== "object") throw new Error("A staff roster entry is invalid.");
    const entry = value as Record<string, unknown>;
    const pin = entry.pinVerifier;
    if (!pin || typeof pin !== "object") throw new Error("A staff roster PIN verifier is invalid.");
    const verifier = pin as Record<string, unknown>;
    const string = (candidate: unknown, field: string): string => {
      if (
        typeof candidate !== "string" ||
        candidate.trim().length === 0 ||
        candidate.length > 400
      ) {
        throw new Error(`Staff roster ${field} is invalid.`);
      }
      return candidate;
    };
    const base64 = (candidate: unknown, field: string): string => {
      const text = string(candidate, field);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text))
        throw new Error(`Staff roster ${field} is invalid.`);
      return text;
    };
    const positiveInt = (candidate: unknown, field: string, minimum: number): number => {
      if (!Number.isSafeInteger(candidate) || Number(candidate) < minimum) {
        throw new Error(`Staff roster ${field} is invalid.`);
      }
      return Number(candidate);
    };
    if (verifier.algorithm !== "scrypt") throw new Error("Unsupported staff roster PIN algorithm.");
    return {
      membershipId: string(entry.membershipId, "membershipId"),
      username: string(entry.username, "username").trim().toLowerCase(),
      displayName: string(entry.displayName, "displayName"),
      saltBase64: base64(verifier.saltBase64, "pin salt"),
      hashBase64: base64(verifier.hashBase64, "pin hash"),
      n: positiveInt(verifier.n, "scrypt n", 2),
      r: positiveInt(verifier.r, "scrypt r", 1),
      p: positiveInt(verifier.p, "scrypt p", 1),
      keyLength: positiveInt(verifier.keyLength, "key length", 16),
    };
  }

  private getDeviceRow(): DeviceRow {
    const row = this.database.connection
      .prepare(
        `SELECT tenant_id, device_id, credential_id, register_id, public_key_fingerprint,
          status, enrollment_idempotency_key, bootstrap_idempotency_key
         FROM device_state WHERE singleton_id = 1`,
      )
      .get() as DeviceRow | undefined;
    if (!row) throw new Error("Local device enrollment has not been prepared.");
    return row;
  }

  private validateBootstrap(bootstrap: OfflineBootstrapResponse): void {
    if (bootstrap.schemaVersion !== 1 || !bootstrap.policy.enabled) {
      throw new Error("The server did not issue an enabled supported offline grant.");
    }
    for (const [field, value] of [
      ["issuedAt", bootstrap.issuedAt],
      ["operatorExpiresAt", bootstrap.operatorExpiresAt],
      ["catalogValidUntil", bootstrap.catalogValidUntil],
      ["acceptedUntil", bootstrap.acceptedUntil],
    ] as const) {
      requireIsoDate(value, field);
    }
    if (
      Date.parse(bootstrap.acceptedUntil) !==
        Math.min(
          Date.parse(bootstrap.operatorExpiresAt),
          Date.parse(bootstrap.catalogValidUntil),
        ) ||
      Date.parse(bootstrap.acceptedUntil) <= Date.parse(bootstrap.issuedAt)
    ) {
      throw new Error("The offline grant time bounds are inconsistent.");
    }
    for (const [field, value] of [
      ["maxSaleAmountMinor", bootstrap.policy.maxSaleAmountMinor],
      ["maxCumulativeExposureMinor", bootstrap.policy.maxCumulativeExposureMinor],
      ["maxQuantityPerLine", bootstrap.policy.maxQuantityPerLine],
      ["maxPendingOfflineSales", bootstrap.policy.maxPendingOfflineSales],
      ["maxOfflineCreditExposureMinor", bootstrap.policy.maxOfflineCreditExposureMinor ?? 0],
    ] as const) {
      requireSafeNonNegative(value, field);
    }
    if (
      bootstrap.policy.maxQuantityPerLine === 0 ||
      bootstrap.policy.maxPendingOfflineSales === 0
    ) {
      throw new Error("Offline grant quantity and pending-sale limits must be positive.");
    }
    const productIds = new Set<string>();
    const variantIds = new Set<string>();
    for (const product of bootstrap.catalog) {
      if (productIds.has(product.productId))
        throw new Error("Duplicate product in offline snapshot.");
      productIds.add(product.productId);
      for (const variant of product.variants) {
        if (variantIds.has(variant.variantId)) {
          throw new Error("Duplicate variant in offline snapshot.");
        }
        variantIds.add(variant.variantId);
        requireSafeNonNegative(variant.authorizedUnitPriceMinor, "authorizedUnitPriceMinor");
        requireSafeNonNegative(variant.advisoryInventory.onHandQuantity, "onHandQuantity");
        requireSafeNonNegative(variant.advisoryInventory.version, "inventoryVersion");
        requireIsoDate(variant.priceVersion, "priceVersion");
        requireIsoDate(variant.advisoryInventory.asOf, "inventoryAsOf");
      }
    }
  }
}
