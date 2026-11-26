import { randomUUID } from "node:crypto";

import { LocalDatabase } from "./database";

/**
 * ADR-042 §4.6 (Finding A) — terminal hold for an offline sale whose offline-created customer the server
 * rejected. The sale itself (local_sale row, its signed outbox command and receipt) is never changed; the
 * hold names the sale's signed fingerprint and, once the server acknowledges it, the sale's ordinal is
 * accounted for (held_for_reconciliation), so the till can close its stock grant and bootstrap again.
 *
 * Lifecycle: pending -> leased -> acknowledged (terminal) | retry_wait | blocked. The command body is fixed
 * at enqueue time and signed exactly once (on first claim); signature and request are immutable afterwards,
 * so a retry after a lost response is byte-identical and the server returns the original receipt.
 */
export const SALE_HOLD_REASON = "customer_dependency_rejected" as const;

export interface SaleHoldSigner {
  /** Sign the canonical hold command with the device key; returns the base64 signature. */
  sign(canonical: string): string;
  /** The device credential the signature verifies under (current active credential). */
  credentialId(): string;
  /** Canonicalize a hold command exactly as the server does (SDK canonicalizer). */
  canonicalize(command: unknown): string;
}

export interface SaleHoldWorkItem {
  readonly syncCommandId: string;
  readonly saleSyncCommandId: string;
  readonly localSaleId: string;
  readonly tenantId: string;
  readonly requestJson: string;
  readonly attempts: number;
  readonly leaseId: string;
}

export interface SaleHoldReceipt {
  readonly holdId: string;
  readonly saleSyncCommandId: string;
  readonly offlineSaleOrdinal: number;
  readonly status: "held_for_reconciliation";
}

export class SaleHoldOutboxStore {
  constructor(
    private readonly database: LocalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Enqueue a hold for every listed held sale that does not have one yet. Must run inside the caller's
   * transaction (the one that marks the dependency held) so a crash can never leave a held sale without
   * its hold command.
   */
  enqueueForHeldSales(saleSyncCommandIds: ReadonlyArray<string>, at: string): number {
    let created = 0;
    for (const saleSyncCommandId of saleSyncCommandIds) {
      const existing = this.database.connection
        .prepare("SELECT 1 FROM sale_hold_outbox WHERE sale_sync_command_id = ?")
        .get(saleSyncCommandId);
      if (existing) continue;
      const sale = this.database.connection
        .prepare(
          `SELECT local_sale_id, canonical_command, payload_hash FROM outbox WHERE sync_command_id = ?`,
        )
        .get(saleSyncCommandId) as
        { local_sale_id: string; canonical_command: string; payload_hash: string } | undefined;
      if (!sale) continue;
      const command = JSON.parse(sale.canonical_command) as {
        syncCommandId: string;
        grantId: string;
        deviceId: string;
        registerId: string;
        localSaleId: string;
        offlineSaleOrdinal: number;
        customerId?: string;
      };
      // Only installment sales name a customer; a hold without one is meaningless.
      if (!command.customerId) continue;
      const hold = {
        schemaVersion: 1,
        syncCommandId: randomUUID(),
        saleSyncCommandId: command.syncCommandId,
        saleCommandFingerprint: sale.payload_hash,
        grantId: command.grantId,
        deviceId: command.deviceId,
        registerId: command.registerId,
        localSaleId: command.localSaleId,
        offlineSaleOrdinal: command.offlineSaleOrdinal,
        customerId: command.customerId,
        reason: SALE_HOLD_REASON,
        requestedAt: at,
      };
      this.database.connection
        .prepare(
          `INSERT INTO sale_hold_outbox(sync_command_id, sale_sync_command_id, local_sale_id, reason,
             command_json, state, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          hold.syncCommandId,
          saleSyncCommandId,
          sale.local_sale_id,
          SALE_HOLD_REASON,
          JSON.stringify(hold),
          at,
          at,
          at,
        );
      created += 1;
    }
    return created;
  }

  /** Claim the next due hold, signing it once (immutably) if it has never been signed. */
  claimNext(leaseDurationMs: number, signer: SaleHoldSigner): SaleHoldWorkItem | null {
    return this.database.transaction(() => {
      const now = this.now();
      const nowIso = now.toISOString();
      const row = this.database.connection
        .prepare(
          `SELECT h.sync_command_id, h.sale_sync_command_id, h.local_sale_id, h.command_json,
             h.request_json, h.attempts, o.request_json AS sale_request_json, g.tenant_id
           FROM sale_hold_outbox h
           JOIN outbox o ON o.sync_command_id = h.sale_sync_command_id
           JOIN local_sale s ON s.local_sale_id = h.local_sale_id
           JOIN offline_grant g ON g.grant_id = s.grant_id
           WHERE h.state IN ('pending', 'retry_wait') AND h.next_attempt_at <= ?
           ORDER BY h.next_attempt_at, h.created_at LIMIT 1`,
        )
        .get(nowIso) as
        | {
            sync_command_id: string;
            sale_sync_command_id: string;
            local_sale_id: string;
            command_json: string;
            request_json: string | null;
            attempts: number;
            sale_request_json: string;
            tenant_id: string;
          }
        | undefined;
      if (!row) return null;
      let requestJson = row.request_json;
      if (requestJson === null) {
        const command = JSON.parse(row.command_json) as Record<string, unknown>;
        const canonical = signer.canonicalize(command);
        const credentialId = signer.credentialId();
        const signature = signer.sign(canonical);
        requestJson = JSON.stringify({
          command,
          signature: { algorithm: "Ed25519", credentialId, value: signature },
          // The original signed sale, exactly as persisted at acceptance.
          sale: JSON.parse(row.sale_request_json),
        });
        this.database.connection
          .prepare(
            `UPDATE sale_hold_outbox SET canonical_command = ?, signature_base64 = ?, credential_id = ?,
               request_json = ?, updated_at = ? WHERE sync_command_id = ? AND signature_base64 IS NULL`,
          )
          .run(canonical, signature, credentialId, requestJson, nowIso, row.sync_command_id);
      }
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.valueOf() + leaseDurationMs).toISOString();
      const result = this.database.connection
        .prepare(
          `UPDATE sale_hold_outbox SET state = 'leased', attempts = attempts + 1, lease_id = ?,
             lease_expires_at = ?, updated_at = ?
           WHERE sync_command_id = ? AND state IN ('pending', 'retry_wait')`,
        )
        .run(leaseId, leaseExpiresAt, nowIso, row.sync_command_id);
      if (result.changes !== 1) return null;
      return {
        syncCommandId: row.sync_command_id,
        saleSyncCommandId: row.sale_sync_command_id,
        localSaleId: row.local_sale_id,
        tenantId: row.tenant_id,
        requestJson,
        attempts: Number(row.attempts) + 1,
        leaseId,
      };
    });
  }

  completeDelivery(syncCommandId: string, leaseId: string, receipt: SaleHoldReceipt): void {
    this.database.transaction(() => {
      const row = this.database.connection
        .prepare("SELECT sale_sync_command_id FROM sale_hold_outbox WHERE sync_command_id = ?")
        .get(syncCommandId) as { sale_sync_command_id: string } | undefined;
      if (
        !row ||
        row.sale_sync_command_id !== receipt.saleSyncCommandId ||
        receipt.status !== "held_for_reconciliation"
      ) {
        throw new Error("The server hold receipt does not match the claimed sale.");
      }
      const at = this.now().toISOString();
      const result = this.database.connection
        .prepare(
          `UPDATE sale_hold_outbox SET state = 'acknowledged', lease_id = NULL, lease_expires_at = NULL,
             server_hold_id = ?, server_receipt_json = ?, acknowledged_at = ?, last_error_code = NULL,
             last_error_message = NULL, updated_at = ?
           WHERE sync_command_id = ? AND state = 'leased' AND lease_id = ?`,
        )
        .run(receipt.holdId, JSON.stringify(receipt), at, at, syncCommandId, leaseId);
      if (result.changes !== 1) {
        throw new Error("The sale hold lease is missing, expired, or owned by another worker.");
      }
    });
  }

  releaseForRetry(
    syncCommandId: string,
    leaseId: string,
    nextAttemptAt: string,
    failure: { readonly code: string; readonly message: string },
  ): void {
    this.transition(
      `UPDATE sale_hold_outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
         lease_expires_at = NULL, last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE sync_command_id = ? AND state = 'leased' AND lease_id = ?`,
      [
        nextAttemptAt,
        failure.code,
        failure.message.slice(0, 500),
        this.now().toISOString(),
        syncCommandId,
        leaseId,
      ],
    );
  }

  markBlocked(
    syncCommandId: string,
    leaseId: string,
    failure: { readonly code: string; readonly message: string },
  ): void {
    this.transition(
      `UPDATE sale_hold_outbox SET state = 'blocked', lease_id = NULL, lease_expires_at = NULL,
         last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE sync_command_id = ? AND state = 'leased' AND lease_id = ?`,
      [
        failure.code,
        failure.message.slice(0, 500),
        this.now().toISOString(),
        syncCommandId,
        leaseId,
      ],
    );
  }

  recoverExpiredLeases(): number {
    const now = this.now().toISOString();
    return Number(
      this.database.connection
        .prepare(
          `UPDATE sale_hold_outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
             lease_expires_at = NULL, last_error_code = 'LEASE_EXPIRED', updated_at = ?
           WHERE state = 'leased' AND lease_expires_at <= ?`,
        )
        .run(now, now, now).changes,
    );
  }

  getStatusCounts(): {
    pending: number;
    leased: number;
    retryWait: number;
    blocked: number;
    acknowledged: number;
  } {
    const rows = this.database.connection
      .prepare("SELECT state, COUNT(*) AS count FROM sale_hold_outbox GROUP BY state")
      .all() as Array<{ state: string; count: number }>;
    const by = (state: string) => Number(rows.find((row) => row.state === state)?.count ?? 0);
    return {
      pending: by("pending"),
      leased: by("leased"),
      retryWait: by("retry_wait"),
      blocked: by("blocked"),
      acknowledged: by("acknowledged"),
    };
  }

  private transition(sql: string, parameters: ReadonlyArray<string | null>): void {
    const result = this.database.connection.prepare(sql).run(...parameters);
    if (result.changes !== 1) {
      throw new Error("The sale hold lease is missing, expired, or owned by another worker.");
    }
  }
}
