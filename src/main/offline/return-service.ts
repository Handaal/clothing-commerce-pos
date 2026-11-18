import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type {
  OfflineReturnCommand,
  OfflineReturnGrantResponse,
  OrderDetailResponse,
} from "@shifted/clothing-commerce-sdk" with { "resolution-mode": "import" };

import type {
  AcceptedOfflineReturn,
  LocalOfflineReturn,
  LocalReturnsState,
  OfflineReturnGrantLineView,
  OfflineReturnGrantView,
  OfflineReturnInput,
  PrepareReturnGrantInput,
} from "../../shared/offline";
import { compareVersions } from "./bootstrap";
import { LocalDatabase } from "./database";
import { DeviceKeyStore } from "./device-key";
import type { OverrideAssertion, OverrideRosterStore } from "./override-roster";
import { approverAssertion, OfflineAcceptanceError } from "./offline-service";

const { canonicalizeOfflineReturnCommand, SDK_VERSION } = createRequire(__filename)(
  "@shifted/clothing-commerce-sdk",
) as {
  canonicalizeOfflineReturnCommand(command: OfflineReturnCommand): string;
  SDK_VERSION: string;
};

/** Same skew allowance the server applies to `acceptedAt` vs grant issuance (and readiness uses). */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;
/** A cached grant is reused for the same order only while at least this much of its window remains. */
const REUSE_MIN_REMAINING_MS = 5 * 60 * 1_000;

export interface ReturnGrantIssueRequest {
  readonly tenantId: string;
  readonly accessToken: string;
  readonly deviceId: string;
  readonly registerId: string;
  readonly orderId: string;
  readonly idempotencyKey: string;
}

/** Online source of a return grant + the server order read used for display labels only. */
export interface ReturnGrantIssuer {
  issue(
    request: ReturnGrantIssueRequest,
  ): Promise<{ readonly grant: OfflineReturnGrantResponse; readonly order: OrderDetailResponse }>;
}

export class SdkReturnGrantIssuer implements ReturnGrantIssuer {
  constructor(private readonly apiBaseUrl: string) {}

  async issue(request: ReturnGrantIssueRequest) {
    const { createCommerceClient } = await import("@shifted/clothing-commerce-sdk");
    const client = createCommerceClient({
      baseUrl: this.apiBaseUrl,
      client: { type: "pos-desktop", version: SDK_VERSION },
      getToken: async () => request.accessToken,
    }).withTenant(request.tenantId);
    const grant = await client.issueOfflineReturnGrant({
      idempotencyKey: request.idempotencyKey,
      deviceId: request.deviceId,
      registerId: request.registerId,
      orderId: request.orderId,
    });
    const order = await client.getOrder(request.orderId);
    return { grant, order };
  }
}

interface DeviceRow {
  device_id: string | null;
  credential_id: string | null;
  status: string;
  tenant_id: string | null;
  register_id: string | null;
  public_key_fingerprint: string | null;
  trusted_local_time: string | null;
}

interface GrantRow {
  return_grant_id: string;
  tenant_id: string;
  device_id: string;
  register_id: string;
  operator_membership_id: string;
  order_id: string;
  order_number: string;
  currency: string;
  issued_at: string;
  expires_at: string;
  allowed_reasons_json: string | null;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/**
 * The offline RETURNS lane (ADR-041 Decision A, POS client half). Mirrors the attendance lane:
 *
 * - ONLINE, the main process fetches a server-issued, order-bound return grant with the operator's
 *   session (the renderer never fabricates authority) and caches it immutably.
 * - OFFLINE, a return may be captured only for lines in a cached, in-window grant, up to the frozen
 *   eligible quantity minus what this device already captured. The signed, immutable command is written
 *   to local_return + local_return_line + return_outbox in ONE SQLite transaction before any network.
 * - The client never computes refund money and never settles: the server recomputes the refund and
 *   creates it PENDING; settlement remains the connected attestation path after sync.
 */
export class OfflineReturnService {
  constructor(
    private readonly database: LocalDatabase,
    private readonly keys: DeviceKeyStore,
    private readonly issuer: ReturnGrantIssuer,
    private readonly now: () => Date = () => new Date(),
    private readonly overrideRoster?: OverrideRosterStore,
  ) {}

  async prepareGrant(input: PrepareReturnGrantInput): Promise<OfflineReturnGrantView> {
    const device = this.requireActiveDevice();
    if (device.tenant_id !== input.tenantId) {
      throw new OfflineAcceptanceError(
        "BINDING_MISMATCH",
        "The return grant tenant does not match the enrolled device.",
      );
    }
    const reusable = this.database.connection
      .prepare(
        `SELECT return_grant_id FROM offline_return_grant
         WHERE order_id = ? AND tenant_id = ? AND device_id = ? AND register_id = ? AND expires_at > ?
         ORDER BY expires_at DESC LIMIT 1`,
      )
      .get(
        input.orderId,
        device.tenant_id,
        device.device_id,
        device.register_id,
        new Date(this.now().valueOf() + REUSE_MIN_REMAINING_MS).toISOString(),
      ) as { return_grant_id: string } | undefined;
    if (reusable) return this.getGrantView(reusable.return_grant_id)!;

    const { grant, order } = await this.issuer.issue({
      tenantId: input.tenantId,
      accessToken: input.accessToken,
      deviceId: device.device_id!,
      registerId: device.register_id!,
      orderId: input.orderId,
      idempotencyKey: randomUUID(),
    });
    this.validateGrant(grant, input, device);
    if (order.header.id !== grant.orderId) {
      throw new OfflineAcceptanceError(
        "BINDING_MISMATCH",
        "The order read does not match the grant.",
      );
    }
    const labels = new Map(order.lines.map((line) => [line.lineNumber, line]));
    const createdAt = this.now().toISOString();
    this.database.transaction(() => {
      const existing = this.database.connection
        .prepare("SELECT 1 AS present FROM offline_return_grant WHERE return_grant_id = ?")
        .get(grant.returnGrantId);
      if (existing) return; // An idempotent re-issue of an already cached immutable grant.
      this.database.connection
        .prepare(
          `INSERT INTO offline_return_grant(
            return_grant_id, schema_version, minimum_client_version, tenant_id, device_id, register_id,
            branch_id, inventory_location_id, operator_membership_id, order_id, order_number, currency,
            issued_at, expires_at, max_refundable_minor, allowed_reasons_json, grant_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grant.returnGrantId,
          grant.schemaVersion,
          grant.minimumClientVersion,
          grant.tenantId,
          grant.deviceId,
          grant.registerId,
          grant.branchId,
          grant.inventoryLocationId,
          grant.operatorMembershipId,
          grant.orderId,
          order.header.orderNumber,
          grant.currency,
          grant.issuedAt,
          grant.expiresAt,
          grant.maxRefundableMinor,
          grant.allowedReasons === null ? null : JSON.stringify(grant.allowedReasons),
          JSON.stringify(grant),
          createdAt,
        );
      const insertLine = this.database.connection.prepare(
        `INSERT INTO offline_return_grant_line(
          return_grant_id, order_line_id, line_number, variant_id, eligible_quantity, unit_price_minor,
          product_name, sku, option_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const line of grant.lines) {
        const label = labels.get(line.lineNumber);
        insertLine.run(
          grant.returnGrantId,
          line.orderLineId,
          line.lineNumber,
          line.variantId,
          line.eligibleQuantity,
          line.unitPriceMinor,
          label?.productName ?? null,
          label?.sku ?? null,
          null,
        );
      }
    });
    return this.getGrantView(grant.returnGrantId)!;
  }

  /** Cached grants for this device that are still inside their acceptance window. */
  getGrants(): ReadonlyArray<OfflineReturnGrantView> {
    const device = this.getDevice();
    if (!device || device.status !== "active" || !device.device_id) return [];
    const rows = this.database.connection
      .prepare(
        `SELECT return_grant_id FROM offline_return_grant
         WHERE device_id = ? AND register_id = ? AND expires_at > ?
         ORDER BY expires_at DESC LIMIT 50`,
      )
      .all(device.device_id, device.register_id, this.now().toISOString()) as Array<{
      return_grant_id: string;
    }>;
    return rows
      .map((row) => this.getGrantView(row.return_grant_id))
      .filter((view): view is OfflineReturnGrantView => view !== null);
  }

  recordReturn(input: OfflineReturnInput): AcceptedOfflineReturn {
    const lines = this.validateInput(input);
    return this.database.transaction(() => {
      const device = this.requireActiveDevice();
      try {
        if (this.keys.loadPublicKey().fingerprint !== device.public_key_fingerprint) {
          throw new Error("fingerprint mismatch");
        }
      } catch {
        throw new OfflineAcceptanceError(
          "PRIVATE_KEY_UNAVAILABLE",
          "The protected device key does not match the enrollment.",
        );
      }
      const grant = this.database.connection
        .prepare(
          `SELECT return_grant_id, tenant_id, device_id, register_id, operator_membership_id, order_id,
            order_number, currency, issued_at, expires_at, allowed_reasons_json, grant_json
           FROM offline_return_grant WHERE return_grant_id = ?`,
        )
        .get(input.returnGrantId) as (GrantRow & { grant_json: string }) | undefined;
      if (!grant) {
        throw new OfflineAcceptanceError("RETURN_GRANT_MISSING", "No cached return grant exists.");
      }
      if (
        grant.tenant_id !== device.tenant_id ||
        grant.device_id !== device.device_id ||
        grant.register_id !== device.register_id
      ) {
        throw new OfflineAcceptanceError(
          "BINDING_MISMATCH",
          "The return grant is bound to another device or register.",
        );
      }
      const now = this.now().valueOf();
      if (
        device.trusted_local_time &&
        now + CLOCK_TOLERANCE_MS < Date.parse(device.trusted_local_time)
      ) {
        throw new OfflineAcceptanceError(
          "CLOCK_ROLLBACK",
          "The local clock moved backwards since the last trusted server contact.",
        );
      }
      if (now + CLOCK_TOLERANCE_MS < Date.parse(grant.issued_at)) {
        throw new OfflineAcceptanceError(
          "CLOCK_ROLLBACK",
          "The local clock is earlier than the return grant issuance.",
        );
      }
      if (now > Date.parse(grant.expires_at)) {
        throw new OfflineAcceptanceError(
          "RETURN_GRANT_EXPIRED",
          "The return grant is outside its window.",
        );
      }
      const allowedReasons =
        grant.allowed_reasons_json === null
          ? null
          : (JSON.parse(grant.allowed_reasons_json) as string[]);
      const view = this.getGrantView(grant.return_grant_id)!;
      for (const line of lines) {
        const granted = view.lines.find((item) => item.orderLineId === line.orderLineId);
        if (!granted) {
          throw new OfflineAcceptanceError(
            "LINE_NOT_GRANTED",
            "A return line is not authorized by the grant.",
          );
        }
        if (line.quantity > granted.remainingQuantity) {
          throw new OfflineAcceptanceError(
            "QUANTITY_EXCEEDS_GRANT",
            "A return quantity exceeds what the grant still authorizes.",
          );
        }
        if (allowedReasons !== null && !allowedReasons.includes(line.reason)) {
          throw new OfflineAcceptanceError(
            "REASON_NOT_ALLOWED",
            "A return reason is not allowed by policy.",
          );
        }
      }

      const acceptedAt = this.now().toISOString();
      const localReturnId = randomUUID();
      const syncCommandId = randomUUID();
      // ADR-042 §6/§7: a grant that requires admin credentials needs a one-use admin assertion for this command.
      const requiresApproval =
        (JSON.parse(grant.grant_json) as { requiresAdminCredentials?: boolean })
          .requiresAdminCredentials === true;
      let adminAssertion: OverrideAssertion | undefined;
      if (requiresApproval) {
        if (!input.approver) {
          throw new OfflineAcceptanceError(
            "ADMIN_CREDENTIALS_REQUIRED",
            "This return requires an admin's POS username and override password.",
          );
        }
        adminAssertion = approverAssertion(
          this.overrideRoster,
          input.approver,
          "payments.refund",
          syncCommandId,
        );
      }
      const command: OfflineReturnCommand = {
        schemaVersion: 1,
        localReturnId,
        syncCommandId,
        returnGrantId: grant.return_grant_id,
        deviceId: device.device_id!,
        registerId: device.register_id!,
        orderId: grant.order_id,
        acceptedAt,
        currency: grant.currency,
        lines: lines.map((line) => ({
          orderLineId: line.orderLineId,
          quantity: line.quantity,
          reason: line.reason,
          disposition: line.disposition,
        })),
        ...(adminAssertion ? { adminAssertion } : {}),
      };
      const canonicalCommand = canonicalizeOfflineReturnCommand(command);
      const signature = this.keys.signCanonical(canonicalCommand);
      const request = {
        command,
        signature: {
          algorithm: "Ed25519" as const,
          credentialId: device.credential_id!,
          value: signature,
        },
      };
      const payloadHash = createHash("sha256").update(canonicalCommand, "utf8").digest("hex");
      this.database.connection
        .prepare(
          `INSERT INTO local_return(
            local_return_id, return_grant_id, order_id, operator_membership_id, currency, accepted_at,
            lifecycle, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'accepted_pending_sync', ?)`,
        )
        .run(
          localReturnId,
          grant.return_grant_id,
          grant.order_id,
          grant.operator_membership_id,
          grant.currency,
          acceptedAt,
          acceptedAt,
        );
      const insertLine = this.database.connection.prepare(
        `INSERT INTO local_return_line(local_return_id, order_line_id, quantity, reason, disposition)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const line of lines) {
        insertLine.run(
          localReturnId,
          line.orderLineId,
          line.quantity,
          line.reason,
          line.disposition,
        );
      }
      this.database.connection
        .prepare(
          `INSERT INTO return_outbox(
            sync_command_id, local_return_id, idempotency_key, canonical_command, payload_hash,
            signature_base64, credential_id, request_json, state, next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          syncCommandId,
          localReturnId,
          syncCommandId,
          canonicalCommand,
          payloadHash,
          signature,
          device.credential_id!,
          JSON.stringify(request),
          acceptedAt,
          acceptedAt,
          acceptedAt,
        );
      return {
        lifecycle: "accepted_pending_sync",
        localReturnId,
        syncCommandId,
        orderId: grant.order_id,
        orderNumber: grant.order_number,
        acceptedAt,
      };
    });
  }

  getLocalReturns(): LocalReturnsState {
    const rows = this.database.connection
      .prepare(
        `SELECT r.local_return_id, r.return_grant_id, r.order_id, g.order_number, r.currency,
          r.accepted_at, r.lifecycle, r.server_return_id, r.refund_id, r.refund_amount_minor,
          r.refund_currency, r.reconciliation_reason
         FROM local_return r
         JOIN offline_return_grant g ON g.return_grant_id = r.return_grant_id
         ORDER BY r.accepted_at DESC, r.local_return_id DESC
         LIMIT 50`,
      )
      .all() as Array<Record<string, string | number | null>>;
    const linesFor = this.database.connection.prepare(
      `SELECT l.order_line_id, l.quantity, l.reason, l.disposition, gl.line_number, gl.product_name,
        gl.sku
       FROM local_return_line l
       LEFT JOIN offline_return_grant_line gl
         ON gl.return_grant_id = ? AND gl.order_line_id = l.order_line_id
       WHERE l.local_return_id = ?
       ORDER BY gl.line_number, l.order_line_id`,
    );
    const recent: LocalOfflineReturn[] = rows.map((row) => ({
      localReturnId: String(row.local_return_id),
      orderId: String(row.order_id),
      orderNumber: String(row.order_number),
      currency: String(row.currency),
      acceptedAt: String(row.accepted_at),
      lifecycle: row.lifecycle as LocalOfflineReturn["lifecycle"],
      serverReturnId: row.server_return_id === null ? null : String(row.server_return_id),
      refund:
        row.refund_id === null
          ? null
          : {
              id: String(row.refund_id),
              amountMinor: Number(row.refund_amount_minor),
              currency: String(row.refund_currency),
              status: "pending" as const,
            },
      reconciliationReason:
        row.reconciliation_reason === null ? null : String(row.reconciliation_reason),
      lines: (
        linesFor.all(String(row.return_grant_id), String(row.local_return_id)) as Array<
          Record<string, string | number | null>
        >
      ).map((line) => ({
        orderLineId: String(line.order_line_id),
        lineNumber: line.line_number === null ? null : Number(line.line_number),
        productName: line.product_name === null ? null : String(line.product_name),
        sku: line.sku === null ? null : String(line.sku),
        quantity: Number(line.quantity),
        reason: String(line.reason),
        disposition: line.disposition as "restock" | "non_restock",
      })),
    }));
    const pending = this.database.connection
      .prepare(
        "SELECT COUNT(*) AS count FROM return_outbox WHERE state IN ('pending','leased','retry_wait')",
      )
      .get() as { count: number };
    return { pending: Number(pending.count), recent };
  }

  private getGrantView(returnGrantId: string): OfflineReturnGrantView | null {
    const grant = this.database.connection
      .prepare(
        `SELECT return_grant_id, order_id, order_number, currency, issued_at, expires_at,
          allowed_reasons_json, grant_json
         FROM offline_return_grant WHERE return_grant_id = ?`,
      )
      .get(returnGrantId) as Record<string, string | null> | undefined;
    if (!grant) return null;
    // Remaining = server-frozen eligibility minus what this device captured that the server could not
    // yet have counted at issuance: still-pending returns, plus synced ones the server received after
    // this grant was issued. Withheld (needs_reconciliation) returns created no canonical Return.
    const lines = this.database.connection
      .prepare(
        `SELECT gl.order_line_id, gl.line_number, gl.variant_id, gl.product_name, gl.sku,
          gl.option_summary, gl.eligible_quantity,
          COALESCE((
            SELECT SUM(l.quantity) FROM local_return_line l
            JOIN local_return r ON r.local_return_id = l.local_return_id
            WHERE r.order_id = ? AND l.order_line_id = gl.order_line_id
              AND (r.lifecycle = 'accepted_pending_sync'
                OR (r.lifecycle = 'synced' AND r.server_received_at >= ?))
          ), 0) AS consumed
         FROM offline_return_grant_line gl
         WHERE gl.return_grant_id = ?
         ORDER BY gl.line_number`,
      )
      .all(String(grant.order_id), String(grant.issued_at), returnGrantId) as Array<
      Record<string, string | number | null>
    >;
    return {
      returnGrantId: String(grant.return_grant_id),
      orderId: String(grant.order_id),
      orderNumber: String(grant.order_number),
      currency: String(grant.currency),
      issuedAt: String(grant.issued_at),
      expiresAt: String(grant.expires_at),
      allowedReasons:
        grant.allowed_reasons_json === null
          ? null
          : (JSON.parse(grant.allowed_reasons_json) as string[]),
      requiresAdminCredentials:
        (JSON.parse(String(grant.grant_json)) as { requiresAdminCredentials?: boolean })
          .requiresAdminCredentials === true,
      lines: lines.map((line): OfflineReturnGrantLineView => ({
        orderLineId: String(line.order_line_id),
        lineNumber: Number(line.line_number),
        variantId: String(line.variant_id),
        productName: line.product_name === null ? null : String(line.product_name),
        sku: line.sku === null ? null : String(line.sku),
        optionSummary: line.option_summary === null ? null : String(line.option_summary),
        grantedQuantity: Number(line.eligible_quantity),
        remainingQuantity: Math.max(0, Number(line.eligible_quantity) - Number(line.consumed)),
      })),
    };
  }

  private validateGrant(
    grant: OfflineReturnGrantResponse,
    input: PrepareReturnGrantInput,
    device: DeviceRow,
  ): void {
    if (
      grant.tenantId !== input.tenantId ||
      grant.deviceId !== device.device_id ||
      grant.registerId !== device.register_id ||
      grant.orderId !== input.orderId
    ) {
      throw new OfflineAcceptanceError(
        "BINDING_MISMATCH",
        "The issued return grant binding does not match this device.",
      );
    }
    if (grant.schemaVersion !== 1) {
      throw new OfflineAcceptanceError(
        "SCHEMA_UNSUPPORTED",
        "The return grant schema is unsupported.",
      );
    }
    if (compareVersions(SDK_VERSION, grant.minimumClientVersion) < 0) {
      throw new OfflineAcceptanceError(
        "CLIENT_TOO_OLD",
        `Offline returns require client ${grant.minimumClientVersion}; installed SDK is ${SDK_VERSION}.`,
      );
    }
    if (
      !/^[A-Z]{3}$/.test(grant.currency) ||
      !(Date.parse(grant.expiresAt) > Date.parse(grant.issuedAt)) ||
      !isNonNegativeInteger(grant.maxRefundableMinor) ||
      !Array.isArray(grant.lines) ||
      grant.lines.length > 500 ||
      new Set(grant.lines.map((line) => line.orderLineId)).size !== grant.lines.length ||
      !grant.lines.every(
        (line) =>
          typeof line.orderLineId === "string" &&
          line.orderLineId.length > 0 &&
          isPositiveInteger(line.lineNumber) &&
          isNonNegativeInteger(line.eligibleQuantity) &&
          isNonNegativeInteger(line.unitPriceMinor),
      )
    ) {
      throw new OfflineAcceptanceError("GRANT_INVALID", "The issued return grant is malformed.");
    }
  }

  private validateInput(input: OfflineReturnInput) {
    if (
      !input ||
      typeof input.returnGrantId !== "string" ||
      input.returnGrantId.length === 0 ||
      input.returnGrantId.length > 200 ||
      !Array.isArray(input.lines) ||
      input.lines.length === 0 ||
      input.lines.length > 100
    ) {
      throw new OfflineAcceptanceError("INPUT_INVALID", "The return input is invalid.");
    }
    const seen = new Set<string>();
    return input.lines.map((line) => {
      const reason = typeof line?.reason === "string" ? line.reason.trim() : "";
      if (
        !line ||
        typeof line.orderLineId !== "string" ||
        line.orderLineId.length === 0 ||
        line.orderLineId.length > 200 ||
        !isPositiveInteger(line.quantity) ||
        reason.length === 0 ||
        reason.length > 500 ||
        (line.disposition !== "restock" && line.disposition !== "non_restock")
      ) {
        throw new OfflineAcceptanceError("INPUT_INVALID", "A return line is invalid.");
      }
      if (seen.has(line.orderLineId)) {
        throw new OfflineAcceptanceError("INPUT_INVALID", "An order line may appear only once.");
      }
      seen.add(line.orderLineId);
      return {
        orderLineId: line.orderLineId,
        quantity: line.quantity,
        reason,
        disposition: line.disposition,
      };
    });
  }

  private getDevice(): DeviceRow | undefined {
    return this.database.connection
      .prepare(
        `SELECT d.device_id, d.credential_id, d.status, d.tenant_id, d.register_id,
          d.public_key_fingerprint, m.trusted_local_time
         FROM device_state d JOIN app_metadata m ON m.singleton_id = 1
         WHERE d.singleton_id = 1`,
      )
      .get() as DeviceRow | undefined;
  }

  private requireActiveDevice(): DeviceRow {
    const device = this.getDevice();
    if (!device) {
      throw new OfflineAcceptanceError("DEVICE_NOT_ENROLLED", "This installation is not enrolled.");
    }
    if (
      device.status !== "active" ||
      !device.device_id ||
      !device.credential_id ||
      !device.tenant_id ||
      !device.register_id
    ) {
      throw new OfflineAcceptanceError("DEVICE_NOT_ACTIVE", "The enrolled device is not active.");
    }
    return device;
  }
}
