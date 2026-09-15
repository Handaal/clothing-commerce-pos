import { randomUUID } from "node:crypto";

import { LocalDatabase } from "./database";

export interface OutboxWorkItem {
  readonly syncCommandId: string;
  readonly localSaleId: string;
  readonly idempotencyKey: string;
  readonly canonicalCommand: string;
  readonly payloadHash: string;
  readonly requestJson: string;
  readonly attempts: number;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
}

export interface DueOutboxItem {
  readonly syncCommandId: string;
  readonly localSaleId: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
}

export class OutboxStore {
  constructor(
    private readonly database: LocalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listDue(limit = 50): ReadonlyArray<DueOutboxItem> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Outbox due-work limit must be between 1 and 100.");
    }
    const now = this.now().toISOString();
    return this.database.connection
      .prepare(
        `SELECT sync_command_id, local_sale_id, attempts, next_attempt_at
         FROM outbox
         WHERE state IN ('pending', 'retry_wait') AND next_attempt_at <= ?
         ORDER BY next_attempt_at, created_at LIMIT ?`,
      )
      .all(now, limit)
      .map((raw) => {
        const row = raw as Record<string, string | number>;
        return {
          syncCommandId: String(row.sync_command_id),
          localSaleId: String(row.local_sale_id),
          attempts: Number(row.attempts),
          nextAttemptAt: String(row.next_attempt_at),
        };
      });
  }

  claimNext(leaseDurationMs: number): OutboxWorkItem | null {
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1_000 ||
      leaseDurationMs > 600_000
    ) {
      throw new Error("Outbox lease duration must be between one second and ten minutes.");
    }
    return this.database.transaction(() => {
      const now = this.now();
      const nowIso = now.toISOString();
      const candidate = this.database.connection
        .prepare(
          `SELECT sync_command_id FROM outbox
           WHERE state IN ('pending', 'retry_wait') AND next_attempt_at <= ?
           ORDER BY next_attempt_at, created_at LIMIT 1`,
        )
        .get(nowIso) as { sync_command_id: string } | undefined;
      if (!candidate) return null;
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.valueOf() + leaseDurationMs).toISOString();
      const result = this.database.connection
        .prepare(
          `UPDATE outbox SET state = 'leased', attempts = attempts + 1,
            lease_id = ?, lease_expires_at = ?, updated_at = ?
           WHERE sync_command_id = ? AND state IN ('pending', 'retry_wait') AND next_attempt_at <= ?`,
        )
        .run(leaseId, leaseExpiresAt, nowIso, candidate.sync_command_id, nowIso);
      if (result.changes !== 1) return null;
      const raw = this.database.connection
        .prepare(
          `SELECT sync_command_id, local_sale_id, idempotency_key, canonical_command,
            payload_hash, request_json, attempts, lease_id, lease_expires_at
           FROM outbox WHERE sync_command_id = ?`,
        )
        .get(candidate.sync_command_id) as Record<string, string | number>;
      return {
        syncCommandId: String(raw.sync_command_id),
        localSaleId: String(raw.local_sale_id),
        idempotencyKey: String(raw.idempotency_key),
        canonicalCommand: String(raw.canonical_command),
        payloadHash: String(raw.payload_hash),
        requestJson: String(raw.request_json),
        attempts: Number(raw.attempts),
        leaseId: String(raw.lease_id),
        leaseExpiresAt: String(raw.lease_expires_at),
      };
    });
  }

  releaseForRetry(
    syncCommandId: string,
    leaseId: string,
    nextAttemptAt: string,
    diagnostic?: { readonly code?: string; readonly message?: string },
  ): void {
    this.transitionLease(
      `UPDATE outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
        lease_expires_at = NULL, last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE sync_command_id = ? AND state = 'leased' AND lease_id = ?`,
      [
        nextAttemptAt,
        diagnostic?.code?.slice(0, 100) ?? null,
        diagnostic?.message?.slice(0, 500) ?? null,
        this.now().toISOString(),
        syncCommandId,
        leaseId,
      ],
    );
  }

  markDelivered(syncCommandId: string, leaseId: string, serverIngestionId: string): void {
    this.transitionLease(
      `UPDATE outbox SET state = 'delivered', lease_id = NULL, lease_expires_at = NULL,
        server_ingestion_id = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
       WHERE sync_command_id = ? AND state = 'leased' AND lease_id = ?`,
      [serverIngestionId, this.now().toISOString(), syncCommandId, leaseId],
    );
  }

  markBlocked(
    syncCommandId: string,
    leaseId: string,
    diagnostic: { readonly code: string; readonly message: string },
  ): void {
    this.transitionLease(
      `UPDATE outbox SET state = 'blocked', lease_id = NULL, lease_expires_at = NULL,
        last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE sync_command_id = ? AND state = 'leased' AND lease_id = ?`,
      [
        diagnostic.code.slice(0, 100),
        diagnostic.message.slice(0, 500),
        this.now().toISOString(),
        syncCommandId,
        leaseId,
      ],
    );
  }

  recoverExpiredLeases(): number {
    const now = this.now().toISOString();
    const result = this.database.connection
      .prepare(
        `UPDATE outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
          lease_expires_at = NULL, last_error_code = 'LEASE_EXPIRED',
          last_error_message = 'Recovered an expired local delivery lease after restart.',
          updated_at = ?
         WHERE state = 'leased' AND lease_expires_at <= ?`,
      )
      .run(now, now, now);
    return Number(result.changes);
  }

  private transitionLease(sql: string, parameters: ReadonlyArray<string | null>): void {
    const result = this.database.connection.prepare(sql).run(...parameters);
    if (result.changes !== 1) {
      throw new Error("The outbox lease is missing, expired, or owned by another worker.");
    }
  }
}
