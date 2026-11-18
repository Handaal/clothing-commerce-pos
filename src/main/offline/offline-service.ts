import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type {
  OfflineAttendanceCommand,
  OfflineCustomerCommand,
  OfflineCustomerPaymentCommand,
  OfflineSaleCommand,
} from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import type {
  AcceptedOfflineAttendanceEvent,
  AcceptedOfflinePayment,
  AcceptedOfflineSale,
  CachedCatalogItem,
  LocalAttendanceEvent,
  LocalAttendanceState,
  LocalReceipt,
  OfflineAttendanceEventInput,
  OfflineCustomer,
  OfflineCustomerPaymentInput,
  OfflineLocalReport,
  OfflineReadiness,
  AcceptedOfflineCustomer,
  OfflineNewCustomerInput,
  OfflineSaleInput,
  OfflineVoucherPreview,
  OfflineVoucherPreviewInput,
  PendingSyncSummary,
  ProjectedInventoryItem,
} from "../../shared/offline";
import { LocalDatabase } from "./database";
import { DeviceKeyStore } from "./device-key";
import type { OverrideAssertion, OverrideRosterStore } from "./override-roster";
import { offlineVoucherDiscount, type OfflineVoucherTerms } from "./voucher-discount";
import {
  voucherCodeFingerprint,
  voucherPolicyIntegrity,
  type VoucherPolicyIntegrityFields,
} from "./voucher-policy";

const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1_000;

// Parse the display-only categories_json column (a JSON string array) defensively: any malformed value
// degrades to no categories rather than throwing, since classification never gates selling.
function parseCategories(value: string | number | null): readonly string[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}
const {
  canonicalizeOfflineSaleCommand,
  canonicalizeOfflineCustomerPaymentCommand,
  canonicalizeOfflineAttendanceCommand,
  canonicalizeOfflineCustomerCommand,
} = createRequire(__filename)("@shifted/clothing-commerce-sdk") as {
  canonicalizeOfflineSaleCommand(command: OfflineSaleCommand): string;
  canonicalizeOfflineCustomerPaymentCommand(command: OfflineCustomerPaymentCommand): string;
  canonicalizeOfflineAttendanceCommand(command: OfflineAttendanceCommand): string;
  canonicalizeOfflineCustomerCommand(command: OfflineCustomerCommand): string;
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
  max_offline_credit_exposure_minor: number;
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

export type OfflineSaleWriteStage = "sale" | "lines" | "tender" | "dependency" | "outbox";

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

/**
 * ADR-042 §6.3: one-use admin assertion for a command, or a deterministic acceptance error. The password
 * is only passed through to the main-process roster check; it is never stored, logged or signed.
 */
export function approverAssertion(
  roster: OverrideRosterStore | undefined,
  approver: { readonly username: string; readonly password: string },
  permission: "promotions.manage" | "payments.refund",
  commandId: string,
): OverrideAssertion {
  const result = roster?.check({ ...approver, permission, commandId }) ?? {
    ok: false as const,
    reason: "UNAVAILABLE" as const,
  };
  if (result.ok) return result.assertion;
  const messages = {
    INVALID: "The admin username or override password is wrong.",
    THROTTLED: "Too many wrong attempts. Try again in a few minutes.",
    NOT_AUTHORIZED: "This admin's permissions don't cover this action at this till.",
    UNAVAILABLE: "Admin credentials can't be checked on this till until it reconnects.",
  } as const;
  throw new OfflineAcceptanceError(`ADMIN_CREDENTIALS_${result.reason}`, messages[result.reason]);
}

export class OfflineSaleService {
  constructor(
    private readonly database: LocalDatabase,
    private readonly keys: DeviceKeyStore,
    private readonly now: () => Date = () => new Date(),
    private readonly testSeam?: OfflineSaleTestSeam,
    private readonly overrideRoster?: OverrideRosterStore,
  ) {}

  /**
   * ADR-043 §5.1: who is operating the till right now, as known to the MAIN process only (the member who
   * unlocked offline with a verified PIN, else the signed-in online operator). Stamped into each signed sale so
   * the server can attribute it to the person who actually sold; the renderer can never supply this value.
   */
  private operatorResolver: () => string | null = () => null;

  setOperatorResolver(resolver: () => string | null): void {
    this.operatorResolver = resolver;
  }

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
    const creditCap = authority.max_offline_credit_exposure_minor;
    const creditRemaining = Math.max(0, creditCap - this.getCreditExposure(authority.grant_id));
    return {
      ready: true,
      deviceId: authority.device_id,
      registerId: authority.grant_register_id,
      inventoryLocationId: authority.inventory_location_id,
      currency: authority.currency,
      acceptedUntil: authority.accepted_until,
      catalogValidUntil: authority.catalog_valid_until,
      offlineLoginAvailable: this.countStaffRoster() > 0,
      offlineInstallmentsAvailable:
        creditCap > 0 && this.countSnapshotCustomers(authority.snapshot_id) > 0,
      offlineCreditRemainingMinor: creditRemaining,
    };
  }

  private countSnapshotCustomers(snapshotId: string): number {
    const row = this.database.connection
      .prepare("SELECT COUNT(*) AS count FROM catalog_customer WHERE snapshot_id = ?")
      .get(snapshotId) as { count: number };
    return Number(row.count);
  }

  /** Total unpaid remainder this grant has extended as installments (advisory, for the credit cap). */
  private getCreditExposure(grantId: string): number {
    const row = this.database.connection
      .prepare(
        "SELECT COALESCE(SUM(outstanding_minor), 0) AS total FROM local_sale WHERE grant_id = ?",
      )
      .get(grantId) as { total: number };
    return Number(row.total);
  }

  // Offline PIN v2: enrollments the latest online bootstrap authorises on this device.
  private countStaffRoster(): number {
    const row = this.database.connection
      .prepare(
        `SELECT COUNT(*) AS count
         FROM offline_pin_authorization r
         JOIN catalog_snapshot c ON c.snapshot_id = r.snapshot_id AND c.state = 'active'`,
      )
      .get() as { count: number };
    return Number(row.count);
  }

  getCachedCatalog(): ReadonlyArray<CachedCatalogItem> {
    return this.database.connection
      .prepare(
        `SELECT p.product_id, p.name AS product_name, p.brand_id, v.variant_id, v.sku,
          v.option_summary, v.currency, v.authorized_unit_price_minor, v.price_id, v.price_version,
          c.brand_name, c.categories_json
         FROM catalog_snapshot s
         JOIN catalog_product p ON p.snapshot_id = s.snapshot_id
         JOIN catalog_variant_price v
           ON v.snapshot_id = p.snapshot_id AND v.product_id = p.product_id
         LEFT JOIN catalog_classification c
           ON c.snapshot_id = p.snapshot_id AND c.product_id = p.product_id
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
          brandName: row.brand_name === null ? null : String(row.brand_name),
          categories: parseCategories(row.categories_json),
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

  getOfflineCustomers(): ReadonlyArray<OfflineCustomer> {
    const snapshot: OfflineCustomer[] = this.database.connection
      .prepare(
        `SELECT c.customer_id, c.name, c.phone, c.snapshot_outstanding_minor,
          COALESCE((
            SELECT SUM(s.outstanding_minor) FROM local_sale s
            WHERE s.customer_id = c.customer_id AND s.projection_released_at IS NULL
          ), 0) AS pending_debt,
          COALESCE((
            SELECT SUM(p.amount_minor) FROM local_customer_payment p
            WHERE p.customer_id = c.customer_id AND p.projection_released_at IS NULL
          ), 0) AS pending_paid
         FROM catalog_snapshot cat
         JOIN catalog_customer c ON c.snapshot_id = cat.snapshot_id
         WHERE cat.state = 'active'
         ORDER BY c.name, c.customer_id`,
      )
      .all()
      .map((raw) => {
        const row = raw as Record<string, string | number>;
        const projected =
          Number(row.snapshot_outstanding_minor) +
          Number(row.pending_debt) -
          Number(row.pending_paid);
        return {
          customerId: String(row.customer_id),
          name: String(row.name),
          phone: String(row.phone),
          projectedOutstandingMinor: Math.max(0, projected),
        };
      });
    // Customers created on this till while offline (name + phone only) can carry an installment / paydown
    // before they sync; the sale/payment then depends on the customer command (see local schema v19).
    const created = this.database.connection
      .prepare(
        `SELECT lc.local_customer_id, lc.name, lc.phone, o.state AS outbox_state,
          COALESCE((
            SELECT SUM(s.outstanding_minor) FROM local_sale s
            WHERE s.customer_id = lc.local_customer_id AND s.projection_released_at IS NULL
          ), 0) AS pending_debt,
          COALESCE((
            SELECT SUM(p.amount_minor) FROM local_customer_payment p
            WHERE p.customer_id = lc.local_customer_id AND p.projection_released_at IS NULL
          ), 0) AS pending_paid
         FROM local_customer lc JOIN customer_outbox o ON o.local_customer_id = lc.local_customer_id
         WHERE o.state <> 'blocked'
         ORDER BY lc.name, lc.local_customer_id`,
      )
      .all()
      .map((raw) => {
        const row = raw as Record<string, string | number>;
        return {
          customerId: String(row.local_customer_id),
          name: String(row.name),
          phone: String(row.phone),
          projectedOutstandingMinor: Math.max(
            0,
            Number(row.pending_debt) - Number(row.pending_paid),
          ),
          createdOffline: true as const,
          pendingSync: String(row.outbox_state) !== "delivered",
        };
      });
    const known = new Set(snapshot.map((item) => item.customerId));
    return [...snapshot, ...created.filter((item) => !known.has(item.customerId))];
  }

  /**
   * A customer this till created offline that may still need to reach the server: its local profile and
   * customer command. Undefined for snapshot customers, unknown ids, and customers the server rejected.
   */
  private offlineCreatedCustomer(customerId: string):
    | {
        readonly localCustomerId: string;
        readonly customerSyncCommandId: string;
        readonly name: string;
        readonly phone: string;
        readonly delivered: boolean;
      }
    | undefined {
    const row = this.database.connection
      .prepare(
        `SELECT lc.local_customer_id, lc.name, lc.phone, o.sync_command_id, o.state
         FROM local_customer lc JOIN customer_outbox o ON o.local_customer_id = lc.local_customer_id
         WHERE lc.local_customer_id = ? AND o.state <> 'blocked'`,
      )
      .get(customerId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      localCustomerId: row.local_customer_id,
      customerSyncCommandId: row.sync_command_id,
      name: row.name,
      phone: row.phone,
      delivered: row.state === "delivered",
    };
  }

  /** Record, in the caller's transaction, that a dependent command must wait for its new customer. */
  private recordCustomerDependency(
    lane: "sale" | "payment",
    dependentSyncCommandId: string,
    customer: NonNullable<ReturnType<OfflineSaleService["offlineCreatedCustomer"]>>,
    acceptedAt: string,
  ): void {
    if (customer.delivered) return; // already accepted server-side under the same id: nothing to wait for
    this.database.connection
      .prepare(
        `INSERT INTO local_customer_dependency(
          dependent_lane, dependent_sync_command_id, local_customer_id, customer_sync_command_id,
          customer_display_name, customer_phone_last4, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)`,
      )
      .run(
        lane,
        dependentSyncCommandId,
        customer.localCustomerId,
        customer.customerSyncCommandId,
        customer.name,
        customer.phone.slice(-4),
        acceptedAt,
      );
  }

  recordCustomerPayment(input: OfflineCustomerPaymentInput): AcceptedOfflinePayment {
    if (
      !input ||
      typeof input.customerId !== "string" ||
      input.customerId.length === 0 ||
      input.customerId.length > 200 ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0
    ) {
      throw new OfflineAcceptanceError("INPUT_INVALID", "The payment input is invalid.");
    }
    return this.database.transaction(() => {
      const readiness = this.getReadiness();
      if (!readiness.ready) throw new OfflineAcceptanceError(readiness.reason, readiness.message);
      const authority = this.getAuthority();
      if (!authority) throw new OfflineAcceptanceError("GRANT_MISSING", "No active grant exists.");
      const customer = this.getOfflineCustomers().find(
        (item) => item.customerId === input.customerId,
      );
      const createdCustomer = this.snapshotCustomerExists(authority.snapshot_id, input.customerId)
        ? undefined
        : this.offlineCreatedCustomer(input.customerId);
      if (
        !customer ||
        (!this.snapshotCustomerExists(authority.snapshot_id, input.customerId) && !createdCustomer)
      ) {
        throw new OfflineAcceptanceError(
          "CUSTOMER_UNKNOWN",
          "The customer is not in the snapshot.",
        );
      }
      if (input.amountMinor > customer.projectedOutstandingMinor) {
        throw new OfflineAcceptanceError(
          "PAYMENT_EXCEEDS_BALANCE",
          "The payment exceeds the customer's projected balance.",
        );
      }
      const acceptedAt = this.now().toISOString();
      const localPaymentId = randomUUID();
      const syncCommandId = randomUUID();
      const command: OfflineCustomerPaymentCommand = {
        schemaVersion: 1,
        localPaymentId,
        syncCommandId,
        grantId: authority.grant_id,
        deviceId: authority.device_id,
        registerId: authority.grant_register_id,
        acceptedAt,
        currency: authority.currency,
        customerId: input.customerId,
        amountMinor: input.amountMinor,
      };
      const canonicalCommand = canonicalizeOfflineCustomerPaymentCommand(command);
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
          `INSERT INTO local_customer_payment(
            local_payment_id, grant_id, snapshot_id, customer_id, currency, amount_minor,
            accepted_at, lifecycle, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted_pending_sync', ?)`,
        )
        .run(
          localPaymentId,
          authority.grant_id,
          authority.snapshot_id,
          input.customerId,
          authority.currency,
          input.amountMinor,
          acceptedAt,
          acceptedAt,
        );
      if (createdCustomer) {
        this.recordCustomerDependency("payment", syncCommandId, createdCustomer, acceptedAt);
      }
      this.database.connection
        .prepare(
          `INSERT INTO payment_outbox(
            sync_command_id, local_payment_id, idempotency_key, canonical_command, payload_hash,
            signature_base64, credential_id, request_json, state, next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          syncCommandId,
          localPaymentId,
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
      return {
        localPaymentId,
        syncCommandId,
        customerId: input.customerId,
        currency: authority.currency,
        amountMinor: input.amountMinor,
        acceptedAt,
        projectedOutstandingMinor: Math.max(
          0,
          customer.projectedOutstandingMinor - input.amountMinor,
        ),
      };
    });
  }

  acceptCashSale(input: OfflineSaleInput): AcceptedOfflineSale {
    this.validateInput(input);
    return this.database.transaction(() => this.acceptInTransaction(input));
  }

  /**
   * ADR-042 §5: price a voucher for the current cart without accepting anything, so the cashier takes
   * payment for the net total. Approval is checked only at acceptance (it is bound to that command).
   */
  previewVoucher(input: OfflineVoucherPreviewInput): OfflineVoucherPreview {
    const readiness = this.getReadiness();
    if (!readiness.ready) throw new OfflineAcceptanceError(readiness.reason, readiness.message);
    const authority = this.getAuthority();
    if (!authority) throw new OfflineAcceptanceError("GRANT_MISSING", "No active grant exists.");
    const lines = input.lines.map((line) => this.resolveLine(authority, line));
    const gross = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    const voucher = this.resolveVoucher(authority, { code: input.code }, lines, gross, "", {
      skipApproval: true,
    });
    return {
      label: voucher.label,
      discountTotalMinor: voucher.discountTotalMinor,
      netTotalMinor: gross - voucher.discountTotalMinor,
      requiresApproval: voucher.requiresApproval,
      ...(voucher.policy ? { policy: voucher.policy } : {}),
    };
  }

  /**
   * ADR-042 §8: capture a NEW customer (name + phone) offline. One SQLite transaction writes the local
   * profile and its signed command to the customer outbox; the server flags (never merges) duplicates.
   */
  acceptNewCustomer(input: OfflineNewCustomerInput): AcceptedOfflineCustomer {
    const name = input.name.trim();
    const phone = input.phone.replace(/[\s()-]/g, "");
    if (name.length < 1 || name.length > 200) {
      throw new OfflineAcceptanceError("INPUT_INVALID", "Enter the customer's name.");
    }
    if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) {
      throw new OfflineAcceptanceError(
        "PHONE_INVALID",
        "Enter the phone with its country code, for example +201001234567.",
      );
    }
    return this.database.transaction(() => {
      const readiness = this.getReadiness();
      if (!readiness.ready) throw new OfflineAcceptanceError(readiness.reason, readiness.message);
      const authority = this.getAuthority();
      if (!authority) throw new OfflineAcceptanceError("GRANT_MISSING", "No active grant exists.");
      const acceptedAt = this.now().toISOString();
      const localCustomerId = randomUUID();
      const syncCommandId = randomUUID();
      const command: OfflineCustomerCommand = {
        schemaVersion: 1,
        syncCommandId,
        localCustomerId,
        grantId: authority.grant_id,
        deviceId: authority.device_id,
        registerId: authority.grant_register_id,
        acceptedAt,
        name,
        phone,
      };
      const canonicalCommand = canonicalizeOfflineCustomerCommand(command);
      const signature = this.keys.signCanonical(canonicalCommand);
      const request = {
        command,
        signature: {
          algorithm: "Ed25519" as const,
          credentialId: authority.credential_id,
          value: signature,
        },
      };
      this.database.connection
        .prepare(
          `INSERT INTO local_customer(local_customer_id, grant_id, name, phone, lifecycle, created_at)
           VALUES (?, ?, ?, ?, 'accepted_pending_sync', ?)`,
        )
        .run(localCustomerId, authority.grant_id, name, phone, acceptedAt);
      this.database.connection
        .prepare(
          `INSERT INTO customer_outbox(
            sync_command_id, local_customer_id, tenant_id, idempotency_key, canonical_command, payload_hash,
            signature_base64, credential_id, request_json, state, next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          syncCommandId,
          localCustomerId,
          authority.grant_tenant_id,
          syncCommandId,
          canonicalCommand,
          createHash("sha256").update(canonicalCommand, "utf8").digest("hex"),
          signature,
          authority.credential_id,
          JSON.stringify(request),
          acceptedAt,
          acceptedAt,
          acceptedAt,
        );
      return { localCustomerId, name, phone, acceptedAt };
    });
  }

  /**
   * Capture an attendance clock event offline. It is APPEND-ONLY and PROVISIONAL: a signed, immutable
   * command is persisted to the local event table + attendance outbox inside ONE SQLite transaction
   * before any network, exactly like the sale/payment path. The event time is the device clock, bounded
   * by the same readiness gate (grant window, clock-rollback tolerance). Attribution is to the active
   * offline-PIN roster operator (the grant operator — Decision C-i); payroll effects are never claimed.
   */
  recordAttendanceEvent(input: OfflineAttendanceEventInput): AcceptedOfflineAttendanceEvent {
    if (!input || (input.eventType !== "clock_in" && input.eventType !== "clock_out")) {
      throw new OfflineAcceptanceError("INPUT_INVALID", "The attendance input is invalid.");
    }
    return this.database.transaction(() => {
      const readiness = this.getReadiness();
      if (!readiness.ready) throw new OfflineAcceptanceError(readiness.reason, readiness.message);
      const authority = this.getAuthority();
      if (!authority) throw new OfflineAcceptanceError("GRANT_MISSING", "No active grant exists.");
      const acceptedAt = this.now().toISOString();
      const localEventId = randomUUID();
      const syncCommandId = randomUUID();
      const membershipId = input.membershipId ?? authority.operator_membership_id;
      const command: OfflineAttendanceCommand = {
        schemaVersion: 1,
        localEventId,
        syncCommandId,
        grantId: authority.grant_id,
        deviceId: authority.device_id,
        registerId: authority.grant_register_id,
        operatorMembershipId: authority.operator_membership_id,
        ...(input.membershipId ? { membershipId } : {}),
        eventType: input.eventType,
        // The device clock is the trustworthy time evidence available from the lease model; it equals
        // acceptedAt here and the server re-bounds both against the grant window + skew allowance.
        eventAt: acceptedAt,
        acceptedAt,
      };
      const canonicalCommand = canonicalizeOfflineAttendanceCommand(command);
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
          `INSERT INTO local_attendance_event(
            local_event_id, grant_id, operator_membership_id, membership_id, event_type, event_at, accepted_at,
            lifecycle, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted_pending_sync', ?)`,
        )
        .run(
          localEventId,
          authority.grant_id,
          authority.operator_membership_id,
          membershipId,
          input.eventType,
          acceptedAt,
          acceptedAt,
          acceptedAt,
        );
      this.database.connection
        .prepare(
          `INSERT INTO attendance_outbox(
            sync_command_id, local_event_id, idempotency_key, canonical_command, payload_hash,
            signature_base64, credential_id, request_json, state, next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          syncCommandId,
          localEventId,
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
      return {
        lifecycle: "accepted_pending_sync",
        localEventId,
        syncCommandId,
        operatorMembershipId: authority.operator_membership_id,
        membershipId,
        eventType: input.eventType,
        eventAt: acceptedAt,
        acceptedAt,
      };
    });
  }

  /**
   * Device-local attendance state for the active offline operator: the latest event (drives the next
   * clock action), how many events are still queued, and a short recent history. Not the server feed.
   */
  getLocalAttendance(membershipId?: string): LocalAttendanceState {
    const target = membershipId ?? this.getAuthority()?.operator_membership_id;
    if (!target) return { lastEvent: null, pending: 0, recent: [] };
    const rows = this.database.connection
      .prepare(
        `SELECT local_event_id, operator_membership_id, membership_id, event_type, event_at, lifecycle
         FROM local_attendance_event
         WHERE membership_id = ?
         ORDER BY event_at DESC, local_event_id DESC
         LIMIT 20`,
      )
      .all(target) as Array<Record<string, string>>;
    const recent: LocalAttendanceEvent[] = rows.map((row) => ({
      localEventId: String(row.local_event_id),
      operatorMembershipId: String(row.operator_membership_id),
      membershipId: String(row.membership_id),
      eventType: row.event_type as LocalAttendanceEvent["eventType"],
      eventAt: String(row.event_at),
      lifecycle: row.lifecycle as LocalAttendanceEvent["lifecycle"],
    }));
    const pending = (
      this.database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM attendance_outbox WHERE state IN ('pending','leased','retry_wait')",
        )
        .get() as { count: number }
    ).count;
    return {
      lastEvent: recent[0] ?? null,
      pending: Number(pending),
      recent,
    };
  }

  getLocalReceipt(localSaleId: string): LocalReceipt | null {
    const sale = this.database.connection
      .prepare(
        `SELECT s.local_sale_id, s.local_receipt_id, s.lifecycle, s.accepted_at, s.acknowledged_at,
          s.currency, s.total_minor, s.customer_id, s.amount_paid_minor, s.outstanding_minor,
          c.name AS customer_name, t.cash_received_minor, t.change_minor
         FROM local_sale s
         JOIN local_cash_tender t ON t.local_sale_id = s.local_sale_id
         LEFT JOIN catalog_customer c
           ON c.snapshot_id = s.snapshot_id AND c.customer_id = s.customer_id
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
      customerId: sale.customer_id === null ? null : String(sale.customer_id),
      customerName: sale.customer_name === null ? null : String(sale.customer_name),
      amountPaidMinor:
        sale.amount_paid_minor === null ? Number(sale.total_minor) : Number(sale.amount_paid_minor),
      outstandingMinor: Number(sale.outstanding_minor),
      lines,
      tenders: this.receiptTenders(localSaleId, sale),
      reconciliationHold: this.receiptHoldState(localSaleId),
    };
  }

  /**
   * ADR-042 §13.3: the tenders exactly as signed. The POS has no payment gateway: every tender (cash,
   * card/Visa, InstaPay, wallet) was handled by the cashier and recorded on this till. Until the sale has
   * synced it is 'recorded_locally'; once the server ledger holds it, 'recorded_in_server_ledger'.
   */
  private receiptTenders(
    localSaleId: string,
    sale: Record<string, string | number | null>,
  ): LocalReceipt["tenders"] {
    const outbox = this.database.connection
      .prepare("SELECT canonical_command FROM outbox WHERE local_sale_id = ?")
      .get(localSaleId) as { canonical_command: string } | undefined;
    const command = outbox
      ? (JSON.parse(outbox.canonical_command) as {
          tenders?: Array<{ method: "cash" | "card" | "instapay" | "wallet"; amountMinor: number }>;
        })
      : {};
    const tenders = command.tenders ?? [
      {
        method: "cash" as const,
        amountMinor:
          sale.amount_paid_minor === null
            ? Number(sale.total_minor)
            : Number(sale.amount_paid_minor),
      },
    ];
    const inServerLedger = sale.lifecycle === "synced" || sale.lifecycle === "needs_reconciliation";
    return tenders.map((tender) => ({
      method: tender.method,
      amountMinor: tender.amountMinor,
      confirmation: inServerLedger
        ? ("recorded_in_server_ledger" as const)
        : ("recorded_locally" as const),
    }));
  }

  /** ADR-042 §4.6: state of the terminal hold of a sale whose new customer was rejected (null if none). */
  private receiptHoldState(localSaleId: string): LocalReceipt["reconciliationHold"] {
    const hold = this.database.connection
      .prepare("SELECT state FROM sale_hold_outbox WHERE local_sale_id = ?")
      .get(localSaleId) as { state: string } | undefined;
    if (!hold) return null;
    return hold.state === "acknowledged"
      ? "held_for_reconciliation"
      : hold.state === "blocked"
        ? "hold_refused"
        : "hold_pending";
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

  /**
   * Project a device-local operational report from durable local state only. Every figure is the
   * sum of what this till has rung — never company-wide and never a financial close. The renderer
   * labels it accordingly and shows the coverage window + generation time. If there are no local
   * sales yet the currency is null and the UI shows an honest "no on-device activity" state.
   */
  getLocalReport(): OfflineLocalReport {
    const conn = this.database.connection;
    const sales = conn
      .prepare(
        `SELECT COUNT(*) AS count,
            COALESCE(SUM(total_minor), 0) AS gross,
            COALESCE(SUM(amount_paid_minor), 0) AS collected,
            COALESCE(SUM(outstanding_minor), 0) AS outstanding,
            MIN(accepted_at) AS coverage_from,
            MAX(accepted_at) AS coverage_to
         FROM local_sale`,
      )
      .get() as Record<string, number | string | null>;
    const lifecycleRows = conn
      .prepare("SELECT lifecycle, COUNT(*) AS count FROM local_sale GROUP BY lifecycle")
      .all() as Array<{ lifecycle: string; count: number }>;
    const lifecycleCount = (value: string) =>
      lifecycleRows.find((row) => row.lifecycle === value)?.count ?? 0;
    // Currency is uniform within a grant; read it from any local sale (null when none exist).
    const currencyRow = conn
      .prepare("SELECT currency FROM local_sale ORDER BY created_at LIMIT 1")
      .get() as { currency: string } | undefined;
    const unacknowledged = conn
      .prepare("SELECT COUNT(*) AS count FROM local_sale WHERE acknowledged_at IS NULL")
      .get() as { count: number };
    const payments = conn
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount_minor), 0) AS total
         FROM local_customer_payment`,
      )
      .get() as { count: number; total: number };
    const pending = this.getPendingSyncSummary();
    return {
      generatedAt: this.now().toISOString(),
      currency: currencyRow ? currencyRow.currency : null,
      coverageFrom: sales.coverage_from === null ? null : String(sales.coverage_from),
      coverageTo: sales.coverage_to === null ? null : String(sales.coverage_to),
      sales: {
        count: Number(sales.count),
        grossMinor: Number(sales.gross),
        collectedMinor: Number(sales.collected),
        outstandingMinor: Number(sales.outstanding),
      },
      lifecycle: {
        acceptedPendingSync: lifecycleCount("accepted_pending_sync"),
        synced: lifecycleCount("synced"),
        needsReconciliation: lifecycleCount("needs_reconciliation"),
      },
      customerPayments: {
        count: Number(payments.count),
        totalMinor: Number(payments.total),
      },
      unacknowledged: Number(unacknowledged.count),
      pending: pending.pending + pending.leased + pending.retryWait,
      blocked: pending.blocked,
    };
  }

  private acceptInTransaction(input: OfflineSaleInput): AcceptedOfflineSale {
    const readiness = this.getReadiness();
    if (!readiness.ready) throw new OfflineAcceptanceError(readiness.reason, readiness.message);
    const authority = this.getAuthority();
    if (!authority) throw new OfflineAcceptanceError("GRANT_MISSING", "No active grant exists.");
    const lineFacts = input.lines.map((line) => this.resolveLine(authority, line));
    // ADR-042 §13: ONE shared stock pool. resolveLine already enforced this till's local ESTIMATE
    // (advisory snapshot minus unsynced local lines); there is no per-till stock grant.
    // Generated up front: an admin approval (ADR-042 §6.3) is bound to this exact command.
    const syncCommandId = randomUUID();
    const grossMinor = lineFacts.reduce((sum, line) => {
      const total = sum + line.lineTotalMinor;
      if (!Number.isSafeInteger(total)) {
        throw new OfflineAcceptanceError(
          "TOTAL_INVALID",
          "The sale total is outside the safe range.",
        );
      }
      return total;
    }, 0);
    // ADR-042 §5: an offline voucher against this till's reserved quota. totalMinor is the net paid.
    const voucher = input.voucher
      ? this.resolveVoucher(authority, input.voucher, lineFacts, grossMinor, syncCommandId)
      : null;
    const totalMinor = grossMinor - (voucher?.discountTotalMinor ?? 0);
    if (totalMinor > authority.max_sale_amount_minor) {
      throw new OfflineAcceptanceError(
        "SALE_LIMIT_EXCEEDED",
        "The grant sale amount limit is exceeded.",
      );
    }
    // Installment resolution. A deposit below the total creates a customer debt; a full (or absent)
    // deposit is a normal fully-settled sale whose command omits the installment fields entirely.
    const amountPaidMinor = input.amountPaidMinor ?? totalMinor;
    if (
      input.amountPaidMinor !== undefined &&
      (!Number.isSafeInteger(input.amountPaidMinor) ||
        input.amountPaidMinor < 0 ||
        input.amountPaidMinor > totalMinor)
    ) {
      throw new OfflineAcceptanceError(
        "INSTALLMENT_INVALID",
        "The deposit is outside the sale total.",
      );
    }
    const isInstallment = amountPaidMinor < totalMinor;
    const outstandingMinor = totalMinor - amountPaidMinor;
    if (isInstallment) {
      if (authority.max_offline_credit_exposure_minor <= 0) {
        throw new OfflineAcceptanceError(
          "INSTALLMENT_UNAVAILABLE",
          "Offline installments are not enabled for this grant.",
        );
      }
      if (amountPaidMinor < 1) {
        throw new OfflineAcceptanceError(
          "INSTALLMENT_INVALID",
          "An installment requires a positive deposit.",
        );
      }
      if (
        !input.customerId ||
        (!this.snapshotCustomerExists(authority.snapshot_id, input.customerId) &&
          !this.offlineCreatedCustomer(input.customerId))
      ) {
        throw new OfflineAcceptanceError(
          "INSTALLMENT_CUSTOMER_REQUIRED",
          "An installment requires a known customer.",
        );
      }
      if (
        this.getCreditExposure(authority.grant_id) + outstandingMinor >
        authority.max_offline_credit_exposure_minor
      ) {
        throw new OfflineAcceptanceError(
          "CREDIT_LIMIT_EXCEEDED",
          "The offline credit limit is exceeded.",
        );
      }
    }
    // Tenders/cash settle only the amount collected now (the deposit for an installment, else the total).
    const settleTarget = amountPaidMinor;
    if (input.tenders) {
      const tenderSum = input.tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
      if (tenderSum !== settleTarget) {
        throw new OfflineAcceptanceError(
          "TENDERS_MISMATCH",
          "The split tenders do not sum to the amount due.",
        );
      }
    } else if (input.cashReceivedMinor < settleTarget) {
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
    const localReceiptId = this.allocateReceipt();
    // For a split sale, the top-level cash fields describe the cash tender only (change comes from it);
    // a cashless split records zero cash received and zero change.
    const cashTender = input.tenders?.find((tender) => tender.method === "cash") ?? null;
    const cashAmountMinor = input.tenders ? (cashTender?.amountMinor ?? 0) : settleTarget;
    const cashReceivedMinor = input.tenders
      ? (cashTender?.cashReceivedMinor ?? cashTender?.amountMinor ?? 0)
      : input.cashReceivedMinor;
    const changeMinor = cashReceivedMinor - cashAmountMinor;
    const unlockedByMembershipId = this.operatorResolver() ?? null;
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
      cashReceivedMinor,
      changeMinor,
      ...(input.tenders
        ? {
            tenders: input.tenders.map((tender) => ({
              method: tender.method,
              amountMinor: tender.amountMinor,
              ...(tender.cashReceivedMinor !== undefined
                ? { cashReceivedMinor: tender.cashReceivedMinor }
                : {}),
            })),
          }
        : {}),
      ...(isInstallment
        ? { customerId: input.customerId!, amountPaidMinor, outstandingMinor }
        : {}),
      offlineSaleOrdinal,
      cumulativeExposureMinor,
      ...(voucher ? { voucher: voucher.command } : {}),
      ...(unlockedByMembershipId ? { unlockedByMembershipId } : {}),
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
          offline_sale_ordinal, cumulative_exposure_minor, customer_id, amount_paid_minor,
          outstanding_minor, voucher_grant_id, discount_total_minor, voucher_label,
          voucher_policy_issuance_id, voucher_code_id, unlocked_by_membership_id, lifecycle, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted_pending_sync', ?)`,
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
        isInstallment ? input.customerId! : null,
        isInstallment ? amountPaidMinor : null,
        outstandingMinor,
        voucher?.voucherGrantId ?? null,
        voucher?.discountTotalMinor ?? 0,
        voucher?.label ?? null,
        voucher?.policyIssuanceId ?? null,
        voucher?.codeId ?? null,
        unlockedByMembershipId,
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
      .run(localSaleId, cashAmountMinor, cashReceivedMinor, changeMinor, acceptedAt);
    this.testSeam?.afterStage?.("tender");
    // An installment for a customer created offline waits for that customer's command (same transaction).
    const dependsOnCustomer =
      isInstallment && !this.snapshotCustomerExists(authority.snapshot_id, input.customerId!)
        ? this.offlineCreatedCustomer(input.customerId!)
        : undefined;
    if (dependsOnCustomer) {
      this.recordCustomerDependency("sale", syncCommandId, dependsOnCustomer, acceptedAt);
      this.testSeam?.afterStage?.("dependency");
    }
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
      cashReceivedMinor,
      changeMinor,
      amountPaidMinor,
      outstandingMinor,
    };
  }

  /** ADR-042 §5/§6.3: resolve an offline voucher against this till's reserved quota and caps. */
  private resolveVoucher(
    authority: AuthorityRow,
    input: NonNullable<OfflineSaleInput["voucher"]>,
    lines: ReadonlyArray<SaleLineFact>,
    grossMinor: number,
    commandId: string,
    options: { readonly skipApproval?: boolean } = {},
  ): ResolvedVoucher {
    const code = input.code?.trim().toUpperCase() ?? "";
    // ADR-042 §13.6: an existing voucher from the lease's cached policy (no reservation) comes first.
    if (code !== "") {
      const cached = this.resolveCachedVoucher(authority, code, lines, grossMinor);
      if (cached) return cached;
    }
    const row = this.database.connection
      .prepare(
        `SELECT voucher_grant_id, promotion_id, code_id, code, allowed_count,
           max_discount_per_redemption_minor, max_discount_per_grant_minor,
           requires_admin_credentials, expires_at, terms_json
         FROM offline_voucher_grant
         WHERE snapshot_id = ? AND (voucher_grant_id = ? OR (code IS NOT NULL AND code = ?))`,
      )
      .get(authority.snapshot_id, input.voucherGrantId ?? "", code) as
      Record<string, string | number | null> | undefined;
    if (!row) {
      throw new OfflineAcceptanceError(
        "VOUCHER_NOT_AVAILABLE",
        "This voucher can't be used offline on this till.",
      );
    }
    const terms = JSON.parse(String(row.terms_json)) as OfflineVoucherTerms & {
      name: string;
      code: string | null;
      endsAt: string | null;
    };
    const now = this.now().valueOf();
    if (
      now > Date.parse(String(row.expires_at)) ||
      (terms.endsAt && now > Date.parse(terms.endsAt))
    ) {
      throw new OfflineAcceptanceError("VOUCHER_EXPIRED", "This voucher has expired.");
    }
    const used = this.database.connection
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(discount_total_minor), 0) AS discount
         FROM local_sale WHERE grant_id = ? AND voucher_grant_id = ?`,
      )
      .get(authority.grant_id, String(row.voucher_grant_id)) as { count: number; discount: number };
    if (Number(used.count) >= Number(row.allowed_count)) {
      throw new OfflineAcceptanceError(
        "VOUCHER_QUOTA_USED",
        "This till has used all of its offline uses of this voucher.",
      );
    }
    const discount = offlineVoucherDiscount(
      terms,
      lines.map((line) => ({
        variantId: line.variantId,
        productId: line.productId,
        lineTotalMinor: line.lineTotalMinor,
      })),
    );
    if (discount <= 0 || discount >= grossMinor) {
      throw new OfflineAcceptanceError(
        "VOUCHER_NOT_APPLICABLE",
        "This voucher does not apply to this sale.",
      );
    }
    if (
      discount > Number(row.max_discount_per_redemption_minor) ||
      Number(used.discount) + discount > Number(row.max_discount_per_grant_minor)
    ) {
      throw new OfflineAcceptanceError(
        "VOUCHER_CAP_REACHED",
        "This discount is above the offline limit set for this voucher.",
      );
    }
    let assertion: OverrideAssertion | undefined;
    if (Number(row.requires_admin_credentials) === 1 && !options.skipApproval) {
      if (!input.approver) {
        throw new OfflineAcceptanceError(
          "ADMIN_CREDENTIALS_REQUIRED",
          "This voucher requires an admin's POS username and override password.",
        );
      }
      assertion = this.checkApprover(input.approver, "promotions.manage", commandId);
    }
    const codeId = row.code_id === null ? undefined : String(row.code_id);
    return {
      voucherGrantId: String(row.voucher_grant_id),
      policyIssuanceId: null,
      codeId: codeId ?? null,
      discountTotalMinor: discount,
      label: terms.code ?? terms.name,
      requiresApproval: Number(row.requires_admin_credentials) === 1,
      command: {
        voucherGrantId: String(row.voucher_grant_id),
        promotionId: String(row.promotion_id),
        ...(codeId ? { codeId } : {}),
        discountTotalMinor: discount,
        ...(assertion ? { adminAssertion: assertion } : {}),
      },
    };
  }

  /**
   * ADR-042 §13.6: price an existing voucher from the lease's cached policy. Returns null when this lease has
   * no cached policy for the code (the caller then tries the superseded reserved grant, which no current
   * server issues, and finally reports "not available offline"). Throws for a known voucher the till must
   * refuse. The local ceiling is best-effort only: this till's own uses since the fetch must stay below the
   * shared remaining usage the server reported; the server still decides at sync.
   */
  private resolveCachedVoucher(
    authority: AuthorityRow,
    code: string,
    lines: ReadonlyArray<SaleLineFact>,
    grossMinor: number,
  ): ResolvedVoucher | null {
    const row = this.database.connection
      .prepare(
        `SELECT policy_issuance_id, promotion_id, code_id, code_fingerprint, channel_policy_version,
           policy_digest, calculation_version, observed_remaining, max_discount_per_redemption_minor,
           requires_admin_credentials, fetched_at, expires_at, terms_json, integrity_sha256
         FROM offline_voucher_policy WHERE snapshot_id = ? AND code_fingerprint = ?`,
      )
      .get(authority.snapshot_id, voucherCodeFingerprint(authority.grant_tenant_id, code)) as
      (VoucherPolicyIntegrityFields & { integrity_sha256: string }) | undefined;
    if (!row) return null;
    const normalized: VoucherPolicyIntegrityFields = {
      policy_issuance_id: String(row.policy_issuance_id),
      promotion_id: String(row.promotion_id),
      code_id: String(row.code_id),
      code_fingerprint: String(row.code_fingerprint),
      channel_policy_version: Number(row.channel_policy_version),
      policy_digest: String(row.policy_digest),
      calculation_version: String(row.calculation_version),
      observed_remaining: row.observed_remaining === null ? null : Number(row.observed_remaining),
      max_discount_per_redemption_minor:
        row.max_discount_per_redemption_minor === null
          ? null
          : Number(row.max_discount_per_redemption_minor),
      requires_admin_credentials: Number(row.requires_admin_credentials),
      fetched_at: String(row.fetched_at),
      expires_at: String(row.expires_at),
      terms_json: String(row.terms_json),
    };
    if (
      voucherPolicyIntegrity(normalized, {
        snapshotId: authority.snapshot_id,
        grantId: authority.grant_id,
      }) !== String(row.integrity_sha256)
    ) {
      throw new OfflineAcceptanceError(
        "VOUCHER_SNAPSHOT_INVALID",
        "This voucher's offline data is damaged. Use it when the till is back online.",
      );
    }
    if (normalized.requires_admin_credentials !== 0) {
      throw new OfflineAcceptanceError(
        "VOUCHER_ONLINE_ONLY",
        "This voucher needs admin approval and can only be used online.",
      );
    }
    const terms = JSON.parse(normalized.terms_json) as OfflineVoucherTerms & {
      name: string;
      endsAt: string | null;
    };
    const now = this.now().valueOf();
    if (
      now > Date.parse(normalized.expires_at) ||
      now > Date.parse(authority.accepted_until) ||
      (terms.endsAt !== null && now >= Date.parse(terms.endsAt))
    ) {
      throw new OfflineAcceptanceError("VOUCHER_EXPIRED", "This voucher has expired.");
    }
    const localUses = this.localVoucherUsesSince(normalized.code_id, normalized.fetched_at);
    if (normalized.observed_remaining !== null && localUses >= normalized.observed_remaining) {
      throw new OfflineAcceptanceError(
        "VOUCHER_LOCAL_LIMIT_REACHED",
        "This voucher reached its last known usage limit on this till. Use it when the till is back online.",
      );
    }
    const discount = offlineVoucherDiscount(
      terms,
      lines.map((line) => ({
        variantId: line.variantId,
        productId: line.productId,
        lineTotalMinor: line.lineTotalMinor,
      })),
    );
    if (discount <= 0 || discount >= grossMinor) {
      throw new OfflineAcceptanceError(
        "VOUCHER_NOT_APPLICABLE",
        "This voucher does not apply to this sale.",
      );
    }
    if (
      normalized.max_discount_per_redemption_minor !== null &&
      discount > normalized.max_discount_per_redemption_minor
    ) {
      throw new OfflineAcceptanceError(
        "VOUCHER_CAP_REACHED",
        "This discount is above the offline limit set for this voucher.",
      );
    }
    const observedRemaining =
      normalized.observed_remaining === null ? null : normalized.observed_remaining - localUses;
    return {
      voucherGrantId: null,
      policyIssuanceId: normalized.policy_issuance_id,
      codeId: normalized.code_id,
      discountTotalMinor: discount,
      label: terms.name,
      requiresApproval: false,
      policy: {
        fetchedAt: normalized.fetched_at,
        expiresAt: normalized.expires_at,
        remainingAtFetch: normalized.observed_remaining,
        localUsesSinceFetch: localUses,
        provisional: true,
      },
      command: {
        policyIssuanceId: normalized.policy_issuance_id,
        promotionId: normalized.promotion_id,
        codeId: normalized.code_id,
        policyDigest: normalized.policy_digest,
        observedRemaining,
        discountTotalMinor: discount,
      },
    };
  }

  /**
   * Durable local usage counter, derived from the sales themselves (same transaction as the sale): this till's
   * uses of the code that the server had NOT yet received when the policy was fetched. Both timestamps are
   * server time (`server_received_at` from the sync response, `fetched_at` from the issuance), so the count
   * does not depend on this till's clock. A sale accepted after the fetch cannot have been received before
   * it, so it is always counted. Conservative: it may over-count, never under-count.
   */
  private localVoucherUsesSince(codeId: string, fetchedAt: string): number {
    const row = this.database.connection
      .prepare(
        `SELECT COUNT(*) AS count FROM local_sale
         WHERE voucher_code_id = ?
           AND (server_received_at IS NULL OR julianday(server_received_at) >= julianday(?))`,
      )
      .get(codeId, fetchedAt) as { count: number };
    return Number(row.count);
  }

  /** ADR-042 §6.3: check an approver's POS username + override password in the main process. */
  checkApprover(
    approver: { readonly username: string; readonly password: string },
    permission: "promotions.manage" | "payments.refund",
    commandId: string,
  ): OverrideAssertion {
    return approverAssertion(this.overrideRoster, approver, permission, commandId);
  }

  private snapshotCustomerExists(snapshotId: string, customerId: string): boolean {
    const row = this.database.connection
      .prepare(
        "SELECT 1 AS present FROM catalog_customer WHERE snapshot_id = ? AND customer_id = ?",
      )
      .get(snapshotId, customerId) as { present: number } | undefined;
    return row !== undefined;
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
    if (
      input.customerId !== undefined &&
      (typeof input.customerId !== "string" ||
        input.customerId.length === 0 ||
        input.customerId.length > 200)
    ) {
      throw new OfflineAcceptanceError("INPUT_INVALID", "The customer id is invalid.");
    }
    if (
      input.amountPaidMinor !== undefined &&
      (!Number.isSafeInteger(input.amountPaidMinor) || input.amountPaidMinor < 0)
    ) {
      throw new OfflineAcceptanceError(
        "INPUT_INVALID",
        "Amount paid must be a non-negative integer.",
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
          g.max_pending_offline_sales, g.max_offline_credit_exposure_minor,
          m.trusted_server_time, m.trusted_local_time
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

/** A voucher resolved for one offline sale (cached policy, or the superseded reserved grant). */
interface ResolvedVoucher {
  readonly voucherGrantId: string | null;
  readonly policyIssuanceId: string | null;
  readonly codeId: string | null;
  readonly discountTotalMinor: number;
  readonly label: string;
  readonly requiresApproval: boolean;
  readonly policy?: NonNullable<OfflineVoucherPreview["policy"]>;
  readonly command: NonNullable<OfflineSaleCommand["voucher"]>;
}
