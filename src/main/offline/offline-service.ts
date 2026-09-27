import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type { OfflineSaleCommand } from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import type {
  AcceptedOfflineSale,
  CachedCatalogItem,
  LocalReceipt,
  OfflineReadiness,
  OfflineSaleInput,
  PendingSyncSummary,
  ProjectedInventoryItem,
} from "../../shared/offline";
import { LocalDatabase } from "./database";
import { DeviceKeyStore } from "./device-key";

const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1_000;
const { canonicalizeOfflineSaleCommand } = createRequire(__filename)(
  "@shifted/clothing-commerce-sdk",
) as {
  canonicalizeOfflineSaleCommand(command: OfflineSaleCommand): string;
};

interface AuthorityRow {
  device_id: string;
  credential_id: string;
  device_status: "active" | "revoked" | "pending";
  device_tenant_id: string;
  device_register_id: string;
  device_location_id: string | null;
  public_key_fingerprint: string;
  grant_id: string;
  snapshot_id: string;
  grant_tenant_id: string;
  grant_device_id: string;
  grant_register_id: string;
  branch_id: string;
  inventory_location_id: string;
  operator_membership_id: string;
  currency: string;
  issued_at: string;
  accepted_until: string;
  catalog_valid_until: string;
  max_sale_amount_minor: number;
  max_cumulative_exposure_minor: number;
  max_quantity_per_line: number;
  max_pending_offline_sales: number;
  trusted_server_time: string | null;
  trusted_local_time: string | null;
}

interface SaleLineFact {
  productId: string;
  productName: string;
  variantId: string;
  variantName: string | null;
  sku: string;
  optionSummary: string | null;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  priceId: string;
  priceVersion: string;
}

export type OfflineSaleWriteStage = "sale" | "lines" | "tender" | "outbox";

export interface OfflineSaleTestSeam {
  afterStage?(stage: OfflineSaleWriteStage): void;
}

export class OfflineAcceptanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OfflineAcceptanceError";
  }
}

export class OfflineSaleService {
  constructor(
    private readonly database: LocalDatabase,
    private readonly keys: DeviceKeyStore,
    private readonly now: () => Date = () => new Date(),
    private readonly testSeam?: OfflineSaleTestSeam,
  ) {}

  getReadiness(): OfflineReadiness {
    const device = this.database.connection
      .prepare("SELECT status FROM device_state WHERE singleton_id = 1")
      .get() as { status: string } | undefined;
    if (!device)
      return this.unavailable("DEVICE_NOT_ENROLLED", "This installation is not enrolled.");
    if (device.status !== "active") {
      return this.unavailable("DEVICE_NOT_ACTIVE", "The enrolled device is not active.");
    }
    const authority = this.getAuthority();
    if (!authority) {
      return this.unavailable("GRANT_MISSING", "No complete active offline grant is cached.");
    }
    try {
      const publicKey = this.keys.loadPublicKey();
      if (publicKey.fingerprint !== authority.public_key_fingerprint) {
        return this.unavailable(
          "PRIVATE_KEY_UNAVAILABLE",
          "The protected device key does not match the enrollment.",
        );
      }
    } catch {
      return this.unavailable(
        "PRIVATE_KEY_UNAVAILABLE",
        "The OS-protected device key is unavailable.",
      );
    }
    if (
      authority.device_tenant_id !== authority.grant_tenant_id ||
      authority.device_id !== authority.grant_device_id ||
      authority.device_register_id !== authority.grant_register_id ||
      authority.device_location_id !== authority.inventory_location_id
    ) {
      return this.unavailable("BINDING_MISMATCH", "The cached grant binding is inconsistent.");
    }
    const now = this.now().valueOf();
    if (
      authority.trusted_local_time &&
      now + CLOCK_ROLLBACK_TOLERANCE_MS < Date.parse(authority.trusted_local_time)
    ) {
      return this.unavailable(
        "CLOCK_ROLLBACK",
        "The local clock moved backwards since the last trusted server contact.",
      );
    }
    if (
      now + CLOCK_ROLLBACK_TOLERANCE_MS < Date.parse(authority.issued_at) ||
      now > Date.parse(authority.accepted_until)
    ) {
      return this.unavailable(
        "GRANT_EXPIRED",
        "The cached offline grant is outside its acceptance window.",
      );
    }
    if (now > Date.parse(authority.catalog_valid_until)) {
      return this.unavailable("CATALOG_EXPIRED", "The active offline catalog has expired.");
    }
    const exposure = this.getGrantExposure(authority.grant_id);
    if (
      exposure.count >= authority.max_pending_offline_sales ||
      exposure.total >= authority.max_cumulative_exposure_minor
    ) {
      return this.unavailable("POLICY_LIMIT_REACHED", "The offline grant policy limit is reached.");
    }
    return {
      ready: true,
      deviceId: authority.device_id,
      registerId: authority.grant_register_id,
      inventoryLocationId: authority.inventory_location_id,
      currency: authority.currency,
      acceptedUntil: authority.accepted_until,
      catalogValidUntil: authority.catalog_valid_until,
    };
  }

  getCachedCatalog(): ReadonlyArray<CachedCatalogItem> {
    return this.database.connection
      .prepare(
        `SELECT p.product_id, p.name AS product_name, p.brand_id, v.variant_id, v.sku,
          v.option_summary, v.currency, v.authorized_unit_price_minor, v.price_id, v.price_version
         FROM catalog_snapshot s
         JOIN catalog_product p ON p.snapshot_id = s.snapshot_id
         JOIN catalog_variant_price v
           ON v.snapshot_id = p.snapshot_id AND v.product_id = p.product_id
         WHERE s.state = 'active' AND p.active = 1 AND v.active = 1
         ORDER BY p.name, v.sku, v.variant_id`,
      )
      .all()
      .map((raw) => {
        const row = raw as Record<string, string | number | null>;
        return {
          productId: String(row.product_id),
          productName: String(row.product_name),
          brandId: String(row.brand_id),
          variantId: String(row.variant_id),
          sku: String(row.sku),
          optionSummary: row.option_summary === null ? null : String(row.option_summary),
          currency: String(row.currency),
          unitPriceMinor: Number(row.authorized_unit_price_minor),
          priceId: String(row.price_id),
          priceVersion: String(row.price_version),
        };
      });
  }

  getProjectedInventory(): ReadonlyArray<ProjectedInventoryItem> {
    return this.database.connection
      .prepare(
        `SELECT i.variant_id, v.sku, i.on_hand, i.version, i.as_of,
          COALESCE(SUM(CASE WHEN s.projection_released_at IS NULL THEN l.quantity ELSE 0 END), 0)
            AS pending_quantity
         FROM catalog_snapshot c
         JOIN inventory_snapshot i ON i.snapshot_id = c.snapshot_id
         JOIN catalog_variant_price v
           ON v.snapshot_id = i.snapshot_id AND v.variant_id = i.variant_id
         LEFT JOIN local_sale_line l ON l.variant_id = i.variant_id
         LEFT JOIN local_sale s ON s.local_sale_id = l.local_sale_id
         WHERE c.state = 'active'
         GROUP BY i.variant_id, v.sku, i.on_hand, i.version, i.as_of
         ORDER BY v.sku, i.variant_id`,
      )
      .all()
      .map((raw) => {
        const row = raw as Record<string, string | number>;
        const snapshotOnHand = Number(row.on_hand);
        const pendingQuantity = Number(row.pending_quantity);
        return {
          variantId: String(row.variant_id),
          sku: String(row.sku),
          snapshotOnHand,
          pendingQuantity,
          projectedAvailable: Math.max(0, snapshotOnHand - pendingQuantity),
          version: Number(row.version),
          asOf: String(row.as_of),
          advisory: true as const,
        };
      });
  }

  acceptCashSale(input: OfflineSaleInput): AcceptedOfflineSale {
    this.validateInput(input);
    return this.database.transaction(() => this.acceptInTransaction(input));
  }

  getLocalReceipt(localSaleId: string): LocalReceipt | null {
    const sale = this.database.connection
      .prepare(
        `SELECT s.local_sale_id, s.local_receipt_id, s.lifecycle, s.accepted_at, s.acknowledged_at,
          s.currency, s.total_minor, t.cash_received_minor, t.change_minor
         FROM local_sale s
         JOIN local_cash_tender t ON t.local_sale_id = s.local_sale_id
         WHERE s.local_sale_id = ?`,
      )
      .get(localSaleId) as Record<string, string | number | null> | undefined;
    if (!sale) return null;
    const lines = this.database.connection
      .prepare(
        `SELECT line_number, product_name, variant_name, variant_id, sku, option_summary,
          quantity, unit_price_minor, line_total_minor
         FROM local_sale_line WHERE local_sale_id = ? ORDER BY line_number`,
      )
      .all(localSaleId)
      .map((raw) => {
        const row = raw as Record<string, string | number | null>;
        return {
          lineNumber: Number(row.line_number),
          productName: String(row.product_name),
          variantName: row.variant_name === null ? null : String(row.variant_name),
          variantId: String(row.variant_id),
          sku: String(row.sku),
          optionSummary: row.option_summary === null ? null : String(row.option_summary),
          quantity: Number(row.quantity),
          unitPriceMinor: Number(row.unit_price_minor),
          lineTotalMinor: Number(row.line_total_minor),
        };
      });
    return {
      localSaleId: String(sale.local_sale_id),
      localReceiptId: String(sale.local_receipt_id),
      lifecycle: sale.lifecycle as LocalReceipt["lifecycle"],
      acceptedAt: String(sale.accepted_at),
      acknowledgedAt: sale.acknowledged_at === null ? null : String(sale.acknowledged_at),
      currency: String(sale.currency),
      totalMinor: Number(sale.total_minor),
      cashReceivedMinor: Number(sale.cash_received_minor),
      changeMinor: Number(sale.change_minor),
      lines,
    };
  }

  /**
   * Every locally accepted sale the cashier has not acknowledged, oldest first. Deterministic
   * ordering guarantees that if several unacknowledged sales somehow exist, recovery presents and
   * resolves them one at a time without discarding any.
   */
  getUnacknowledgedSales(): ReadonlyArray<LocalReceipt> {
    const ids = this.database.connection
      .prepare(
        `SELECT local_sale_id FROM local_sale
         WHERE acknowledged_at IS NULL
         ORDER BY created_at, local_sale_id`,
      )
      .all() as Array<{ local_sale_id: string }>;
    return ids
      .map((row) => this.getLocalReceipt(row.local_sale_id))
      .filter((receipt): receipt is LocalReceipt => receipt !== null);
  }

  /**
   * Record the cashier's acknowledgement of a specific accepted sale. Write-once (the schema trigger
   * rejects re-acknowledgement); acknowledging an already-acknowledged sale is a no-op that returns
   * the current receipt. Never touches synchronization state or the outbox.
   */
  acknowledgeSale(localSaleId: string): LocalReceipt {
    return this.database.transaction(() => {
      const existing = this.getLocalReceipt(localSaleId);
      if (!existing) throw new OfflineAcceptanceError("SALE_NOT_FOUND", "The sale does not exist.");
      if (existing.acknowledgedAt === null) {
        this.database.connection
          .prepare(
            "UPDATE local_sale SET acknowledged_at = ? WHERE local_sale_id = ? AND acknowledged_at IS NULL",
          )
          .run(this.now().toISOString(), localSaleId);
      }
      return this.getLocalReceipt(localSaleId)!;
    });
  }

  getPendingSyncSummary(): PendingSyncSummary {
    const rows = this.database.connection
      .prepare("SELECT state, COUNT(*) AS count FROM outbox GROUP BY state")
      .all() as Array<{ state: string; count: number }>;
    const count = (state: string) => rows.find((row) => row.state === state)?.count ?? 0;
    return {
      pending: count("pending"),
      leased: count("leased"),
      retryWait: count("retry_wait"),
      blocked: count("blocked"),
    };
  }

  private acceptInTransaction(input: OfflineSaleInput): AcceptedOfflineSale {
    const readiness = this.getReadiness();
    if (!readiness.ready) throw new OfflineAcceptanceError(readiness.reason, readiness.message);
    const authority = this.getAuthority();
    if (!authority) throw new OfflineAcceptanceError("GRANT_MISSING", "No active grant exists.");
    const lineFacts = input.lines.map((line) => this.resolveLine(authority, line));
    const totalMinor = lineFacts.reduce((sum, line) => {
      const total = sum + line.lineTotalMinor;
      if (!Number.isSafeInteger(total)) {
        throw new OfflineAcceptanceError(
          "TOTAL_INVALID",
          "The sale total is outside the safe range.",
        );
      }
      return total;
    }, 0);
    if (totalMinor > authority.max_sale_amount_minor) {
      throw new OfflineAcceptanceError(
        "SALE_LIMIT_EXCEEDED",
        "The grant sale amount limit is exceeded.",
      );
    }
    if (input.cashReceivedMinor < totalMinor) {
      throw new OfflineAcceptanceError(
        "INSUFFICIENT_CASH",
        "Cash received is below the amount due.",
      );
    }
    const exposure = this.getGrantExposure(authority.grant_id);
    const offlineSaleOrdinal = exposure.count + 1;
    const cumulativeExposureMinor = exposure.total + totalMinor;
    if (
      offlineSaleOrdinal > authority.max_pending_offline_sales ||
      cumulativeExposureMinor > authority.max_cumulative_exposure_minor
    ) {
      throw new OfflineAcceptanceError(
        "POLICY_LIMIT_REACHED",
        "The offline grant limit is exceeded.",
      );
    }

    const acceptedAt = this.now().toISOString();
    const localSaleId = randomUUID();
    const syncCommandId = randomUUID();
    const localReceiptId = this.allocateReceipt();
    const changeMinor = input.cashReceivedMinor - totalMinor;
    const command: OfflineSaleCommand = {
      schemaVersion: 1,
      localSaleId,
      syncCommandId,
      grantId: authority.grant_id,
      deviceId: authority.device_id,
      registerId: authority.grant_register_id,
      acceptedAt,
      currency: authority.currency,
      lines: lineFacts.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        grantedUnitPriceMinor: line.unitPriceMinor,
        priceId: line.priceId,
      })),
      totalMinor,
      cashReceivedMinor: input.cashReceivedMinor,
      changeMinor,
      offlineSaleOrdinal,
      cumulativeExposureMinor,
    };
    const canonicalCommand = canonicalizeOfflineSaleCommand(command);
    const signature = this.keys.signCanonical(canonicalCommand);
    const request = {
      command,
      signature: {
        algorithm: "Ed25519" as const,
        credentialId: authority.credential_id,
        value: signature,
      },
    };
    const payloadHash = createHash("sha256").update(canonicalCommand, "utf8").digest("hex");

    this.database.connection
      .prepare(
        `INSERT INTO local_sale(
          local_sale_id, local_receipt_id, grant_id, snapshot_id, device_id, register_id,
          inventory_location_id, operator_membership_id, accepted_at, currency, total_minor,
          offline_sale_ordinal, cumulative_exposure_minor, lifecycle, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted_pending_sync', ?)`,
      )
      .run(
        localSaleId,
        localReceiptId,
        authority.grant_id,
        authority.snapshot_id,
        authority.device_id,
        authority.grant_register_id,
        authority.inventory_location_id,
        authority.operator_membership_id,
        acceptedAt,
        authority.currency,
        totalMinor,
        offlineSaleOrdinal,
        cumulativeExposureMinor,
        acceptedAt,
      );
    this.testSeam?.afterStage?.("sale");
    const insertLine = this.database.connection.prepare(
      `INSERT INTO local_sale_line(
        local_sale_id, line_number, product_id, product_name, variant_id, variant_name,
        sku, option_summary, quantity, unit_price_minor, line_total_minor, price_id, price_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    lineFacts.forEach((line, index) =>
      insertLine.run(
        localSaleId,
        index + 1,
        line.productId,
        line.productName,
        line.variantId,
        line.variantName,
        line.sku,
        line.optionSummary,
        line.quantity,
        line.unitPriceMinor,
        line.lineTotalMinor,
        line.priceId,
        line.priceVersion,
      ),
    );
    this.testSeam?.afterStage?.("lines");
    this.database.connection
      .prepare(
        `INSERT INTO local_cash_tender(
          local_sale_id, amount_due_minor, cash_received_minor, change_minor, accepted_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(localSaleId, totalMinor, input.cashReceivedMinor, changeMinor, acceptedAt);
    this.testSeam?.afterStage?.("tender");
    this.database.connection
      .prepare(
        `INSERT INTO outbox(
          sync_command_id, local_sale_id, idempotency_key, canonical_command, payload_hash,
          signature_base64, credential_id, request_json, state, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        syncCommandId,
        localSaleId,
        syncCommandId,
        canonicalCommand,
        payloadHash,
        signature,
        authority.credential_id,
        JSON.stringify(request),
        acceptedAt,
        acceptedAt,
        acceptedAt,
      );
    this.testSeam?.afterStage?.("outbox");
    return {
      lifecycle: "accepted_pending_sync",
      localSaleId,
      localReceiptId,
      syncCommandId,
      acceptedAt,
      currency: authority.currency,
      totalMinor,
      cashReceivedMinor: input.cashReceivedMinor,
      changeMinor,
    };
  }

  private resolveLine(
    authority: AuthorityRow,
    input: { readonly variantId: string; readonly quantity: number },
  ): SaleLineFact {
    if (input.quantity > authority.max_quantity_per_line) {
      throw new OfflineAcceptanceError(
        "LINE_LIMIT_EXCEEDED",
        "The grant line quantity limit is exceeded.",
      );
    }
    const row = this.database.connection
      .prepare(
        `SELECT p.product_id, p.name AS product_name, v.variant_id, v.option_summary,
          v.sku, v.authorized_unit_price_minor, v.price_id, v.price_version,
          i.on_hand, i.valid_until,
          COALESCE((
            SELECT SUM(l.quantity) FROM local_sale_line l
            JOIN local_sale s ON s.local_sale_id = l.local_sale_id
            WHERE l.variant_id = v.variant_id AND s.projection_released_at IS NULL
          ), 0) AS pending_quantity
         FROM catalog_product p
         JOIN catalog_variant_price v
           ON v.snapshot_id = p.snapshot_id AND v.product_id = p.product_id
         LEFT JOIN inventory_snapshot i
           ON i.snapshot_id = v.snapshot_id AND i.variant_id = v.variant_id
             AND i.inventory_location_id = ?
         WHERE v.snapshot_id = ? AND v.variant_id = ? AND p.active = 1 AND v.active = 1`,
      )
      .get(authority.inventory_location_id, authority.snapshot_id, input.variantId) as
      Record<string, string | number | null> | undefined;
    if (!row) {
      throw new OfflineAcceptanceError("PRICE_MISSING", "The variant has no active granted price.");
    }
    if (row.on_hand === null || row.valid_until === null) {
      throw new OfflineAcceptanceError(
        "INVENTORY_MISSING",
        "The advisory inventory snapshot is missing.",
      );
    }
    if (this.now().valueOf() > Date.parse(String(row.valid_until))) {
      throw new OfflineAcceptanceError(
        "INVENTORY_EXPIRED",
        "The advisory inventory snapshot has expired.",
      );
    }
    const projected = Number(row.on_hand) - Number(row.pending_quantity);
    if (input.quantity > projected) {
      throw new OfflineAcceptanceError(
        "PROJECTED_STOCK_INSUFFICIENT",
        "The requested quantity exceeds projected advisory stock.",
      );
    }
    const unitPriceMinor = Number(row.authorized_unit_price_minor);
    const lineTotalMinor = unitPriceMinor * input.quantity;
    if (!Number.isSafeInteger(lineTotalMinor)) {
      throw new OfflineAcceptanceError(
        "TOTAL_INVALID",
        "The line total is outside the safe range.",
      );
    }
    return {
      productId: String(row.product_id),
      productName: String(row.product_name),
      variantId: String(row.variant_id),
      variantName: row.option_summary === null ? null : String(row.option_summary),
      sku: String(row.sku),
      optionSummary: row.option_summary === null ? null : String(row.option_summary),
      quantity: input.quantity,
      unitPriceMinor,
      lineTotalMinor,
      priceId: String(row.price_id),
      priceVersion: String(row.price_version),
    };
  }

  private validateInput(input: OfflineSaleInput): void {
    if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 100) {
      throw new OfflineAcceptanceError("INPUT_INVALID", "One to 100 sale lines are required.");
    }
    if (!Number.isSafeInteger(input.cashReceivedMinor) || input.cashReceivedMinor < 0) {
      throw new OfflineAcceptanceError(
        "INPUT_INVALID",
        "Cash received must be a non-negative integer.",
      );
    }
    const variants = new Set<string>();
    for (const line of input.lines) {
      if (
        !line ||
        typeof line.variantId !== "string" ||
        line.variantId.length === 0 ||
        line.variantId.length > 200 ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0
      ) {
        throw new OfflineAcceptanceError("INPUT_INVALID", "Every sale line is invalid.");
      }
      if (variants.has(line.variantId)) {
        throw new OfflineAcceptanceError("INPUT_INVALID", "A variant may appear only once.");
      }
      variants.add(line.variantId);
    }
  }

  private allocateReceipt(): string {
    const metadata = this.database.connection
      .prepare(
        "SELECT receipt_prefix, next_receipt_number FROM app_metadata WHERE singleton_id = 1",
      )
      .get() as { receipt_prefix: string; next_receipt_number: number };
    const receipt = `${metadata.receipt_prefix}-${String(metadata.next_receipt_number).padStart(6, "0")}`;
    this.database.connection
      .prepare(
        "UPDATE app_metadata SET next_receipt_number = next_receipt_number + 1 WHERE singleton_id = 1",
      )
      .run();
    return receipt;
  }

  private getAuthority(): AuthorityRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT d.device_id, d.credential_id, d.status AS device_status,
          d.tenant_id AS device_tenant_id, d.register_id AS device_register_id,
          d.inventory_location_id AS device_location_id, d.public_key_fingerprint,
          g.grant_id, g.snapshot_id, g.tenant_id AS grant_tenant_id,
          g.device_id AS grant_device_id, g.register_id AS grant_register_id, g.branch_id,
          g.inventory_location_id, g.operator_membership_id, g.currency, g.issued_at,
          g.accepted_until, g.catalog_valid_until, g.max_sale_amount_minor,
          g.max_cumulative_exposure_minor, g.max_quantity_per_line,
          g.max_pending_offline_sales, m.trusted_server_time, m.trusted_local_time
         FROM device_state d
         JOIN catalog_snapshot c ON c.state = 'active'
         JOIN offline_grant g ON g.grant_id = c.grant_id
         JOIN app_metadata m ON m.singleton_id = 1
         WHERE d.singleton_id = 1 AND c.state = 'active'`,
      )
      .get() as AuthorityRow | undefined;
  }

  private getGrantExposure(grantId: string): { count: number; total: number } {
    const row = this.database.connection
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total_minor), 0) AS total
         FROM local_sale WHERE grant_id = ?`,
      )
      .get(grantId) as { count: number; total: number };
    return { count: Number(row.count), total: Number(row.total) };
  }

  private unavailable(
    reason: Exclude<OfflineReadiness, { ready: true }>["reason"],
    message: string,
  ) {
    return { ready: false as const, reason, message };
  }
}
