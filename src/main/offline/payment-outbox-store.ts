import { randomUUID } from "node:crypto";

import type { IngestOfflineCustomerPaymentResponse } from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import { LocalDatabase } from "./database";

export interface PaymentOutboxWorkItem {
  readonly syncCommandId: string;
  readonly localPaymentId: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly canonicalCommand: string;
  readonly payloadHash: string;
  readonly requestJson: string;
  readonly credentialId: string;
  readonly attempts: number;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
}

export interface PaymentSyncCounts {
  readonly pending: number;
  readonly leased: number;
  readonly retryWait: number;
  readonly blocked: number;
  readonly synced: number;
}

/**
 * Durable leased delivery queue for offline customer paydowns — the payment-lane sibling of OutboxStore.
 * Identical lease/retry/blocking semantics; on delivery it marks the local payment synced and records the
 * server's authoritative balance, rather than touching any sale/fulfillment state.
 */
export class PaymentOutboxStore {
  constructor(
    private readonly database: LocalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  claimNext(leaseDurationMs: number): PaymentOutboxWorkItem | null {
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1_000 ||
      leaseDurationMs > 600_000
    ) {
      throw new Error("Payment outbox lease duration must be between one second and ten minutes.");
    }
    return this.database.transaction(() => {
      const now = this.now();
      const nowIso = now.toISOString();
      const candidate = this.database.connection
        .prepare(
          `SELECT sync_command_id FROM payment_outbox
           WHERE state IN ('pending', 'retry_wait') AND next_attempt_at <= ?
           ORDER BY next_attempt_at, created_at LIMIT 1`,
        )
        .get(nowIso) as { sync_command_id: string } | undefined;
      if (!candidate) return null;
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.valueOf() + leaseDurationMs).toISOString();
      const result = this.database.connection
        .prepare(
          `UPDATE payment_outbox SET state = 'leased', attempts = attempts + 1,
            lease_id = ?, lease_expires_at = ?, updated_at = ?
           WHERE sync_command_id = ? AND state IN ('pending', 'retry_wait') AND next_attempt_at <= ?`,
        )
        .run(leaseId, leaseExpiresAt, nowIso, candidate.sync_command_id, nowIso);
      if (result.changes !== 1) return null;
      const raw = this.database.connection
        .prepare(
          `SELECT o.sync_command_id, o.local_payment_id, g.tenant_id, o.idempotency_key,
            o.canonical_command, o.payload_hash, o.request_json, o.credential_id,
            o.attempts, o.lease_id, o.lease_expires_at
           FROM payment_outbox o
           JOIN local_customer_payment p ON p.local_payment_id = o.local_payment_id
           JOIN offline_grant g ON g.grant_id = p.grant_id
           WHERE o.sync_command_id = ?`,
        )
        .get(candidate.sync_command_id) as Record<string, string | number>;
      return {
        syncCommandId: String(raw.sync_command_id),
        localPaymentId: String(raw.local_payment_id),
        tenantId: String(raw.tenant_id),
        idempotencyKey: String(raw.idempotency_key),
        canonicalCommand: String(raw.canonical_command),
        payloadHash: String(raw.payload_hash),
        requestJson: String(raw.request_json),
        credentialId: String(raw.credential_id),
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
      `UPDATE payment_outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
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

  completeDelivery(
    syncCommandId: string,
    leaseId: string,
    response: IngestOfflineCustomerPaymentResponse,
  ): void {
    this.database.transaction(() => {
      const command = this.database.connection
        .prepare("SELECT local_payment_id FROM payment_outbox WHERE sync_command_id = ?")
        .get(syncCommandId) as { local_payment_id: string } | undefined;
      if (!command || command.local_payment_id !== response.localPaymentId) {
        throw new Error("The server response does not match the claimed local payment.");
      }
      this.transitionLease(
        `UPDATE payment_outbox SET state = 'delivered', lease_id = NULL, lease_expires_at = NULL,
          server_ingestion_id = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
         WHERE sync_command_id = ? AND state = 'leased' AND lease_id = ?`,
        [response.ingestionId, this.now().toISOString(), syncCommandId, leaseId],
      );
      const payment = this.database.connection
        .prepare(
          `UPDATE local_customer_payment SET lifecycle = 'synced', server_payment_id = ?,
            server_outstanding_minor = ?, server_received_at = ?, synchronized_at = ?
           WHERE local_payment_id = ? AND lifecycle = 'accepted_pending_sync'`,
        )
        .run(
          response.payment.id,
          response.payment.outstandingMinor,
          response.receivedAt,
          this.now().toISOString(),
          response.localPaymentId,
        );
      if (payment.changes !== 1) {
        throw new Error("The claimed local payment is not pending synchronization.");
      }
    });
  }

  markBlocked(
    syncCommandId: string,
    leaseId: string,
    diagnostic: { readonly code: string; readonly message: string },
  ): void {
    this.transitionLease(
      `UPDATE payment_outbox SET state = 'blocked', lease_id = NULL, lease_expires_at = NULL,
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
        `UPDATE payment_outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
          lease_expires_at = NULL, last_error_code = 'LEASE_EXPIRED',
          last_error_message = 'Recovered an expired local payment lease after restart.',
          updated_at = ?
         WHERE state = 'leased' AND lease_expires_at <= ?`,
      )
      .run(now, now, now);
    return Number(result.changes);
  }

  getStatusCounts(): PaymentSyncCounts {
    const outboxRows = this.database.connection
      .prepare("SELECT state, COUNT(*) AS count FROM payment_outbox GROUP BY state")
      .all() as Array<{ state: string; count: number }>;
    const paymentRows = this.database.connection
      .prepare("SELECT lifecycle, COUNT(*) AS count FROM local_customer_payment GROUP BY lifecycle")
      .all() as Array<{ lifecycle: string; count: number }>;
    const outboxCount = (state: string) =>
      Number(outboxRows.find((row) => row.state === state)?.count ?? 0);
    return {
      pending: outboxCount("pending"),
      leased: outboxCount("leased"),
      retryWait: outboxCount("retry_wait"),
      blocked: outboxCount("blocked"),
      synced: Number(paymentRows.find((row) => row.lifecycle === "synced")?.count ?? 0),
    };
  }

  private transitionLease(sql: string, parameters: ReadonlyArray<string | null>): void {
    const result = this.database.connection.prepare(sql).run(...parameters);
    if (result.changes !== 1) {
      throw new Error("The payment outbox lease is missing, expired, or owned by another worker.");
    }
  }
}
