import { randomUUID } from "node:crypto";

import type { IngestOfflineAttendanceResponse } from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import { LocalDatabase } from "./database";

export interface AttendanceOutboxWorkItem {
  readonly syncCommandId: string;
  readonly localEventId: string;
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

export interface AttendanceSyncCounts {
  readonly pending: number;
  readonly leased: number;
  readonly retryWait: number;
  readonly blocked: number;
  readonly received: number;
}

/**
 * Durable leased delivery queue for offline attendance clock events — the attendance-lane sibling of
 * OutboxStore / PaymentOutboxStore. Identical lease/retry/blocking semantics; on delivery it marks the
 * local event `received` (the server acknowledged durable, provisional receipt — never payroll-final) and
 * records the server ingestion id. It never mutates any sale/payment/fulfillment state.
 */
export class AttendanceOutboxStore {
  constructor(
    private readonly database: LocalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  claimNext(leaseDurationMs: number): AttendanceOutboxWorkItem | null {
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1_000 ||
      leaseDurationMs > 600_000
    ) {
      throw new Error(
        "Attendance outbox lease duration must be between one second and ten minutes.",
      );
    }
    return this.database.transaction(() => {
      const now = this.now();
      const nowIso = now.toISOString();
      const candidate = this.database.connection
        .prepare(
          `SELECT sync_command_id FROM attendance_outbox
           WHERE state IN ('pending', 'retry_wait') AND next_attempt_at <= ?
           ORDER BY next_attempt_at, created_at LIMIT 1`,
        )
        .get(nowIso) as { sync_command_id: string } | undefined;
      if (!candidate) return null;
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.valueOf() + leaseDurationMs).toISOString();
      const result = this.database.connection
        .prepare(
          `UPDATE attendance_outbox SET state = 'leased', attempts = attempts + 1,
            lease_id = ?, lease_expires_at = ?, updated_at = ?
           WHERE sync_command_id = ? AND state IN ('pending', 'retry_wait') AND next_attempt_at <= ?`,
        )
        .run(leaseId, leaseExpiresAt, nowIso, candidate.sync_command_id, nowIso);
      if (result.changes !== 1) return null;
      const raw = this.database.connection
        .prepare(
          `SELECT o.sync_command_id, o.local_event_id, g.tenant_id, o.idempotency_key,
            o.canonical_command, o.payload_hash, o.request_json, o.credential_id,
            o.attempts, o.lease_id, o.lease_expires_at
           FROM attendance_outbox o
           JOIN local_attendance_event e ON e.local_event_id = o.local_event_id
           JOIN offline_grant g ON g.grant_id = e.grant_id
           WHERE o.sync_command_id = ?`,
        )
        .get(candidate.sync_command_id) as Record<string, string | number>;
      return {
        syncCommandId: String(raw.sync_command_id),
        localEventId: String(raw.local_event_id),
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
      `UPDATE attendance_outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
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
    response: IngestOfflineAttendanceResponse,
  ): void {
    this.database.transaction(() => {
      const command = this.database.connection
        .prepare("SELECT local_event_id FROM attendance_outbox WHERE sync_command_id = ?")
        .get(syncCommandId) as { local_event_id: string } | undefined;
      if (!command || command.local_event_id !== response.localEventId) {
        throw new Error("The server response does not match the claimed local attendance event.");
      }
      this.transitionLease(
        `UPDATE attendance_outbox SET state = 'delivered', lease_id = NULL, lease_expires_at = NULL,
          server_ingestion_id = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
         WHERE sync_command_id = ? AND state = 'leased' AND lease_id = ?`,
        [response.ingestionId, this.now().toISOString(), syncCommandId, leaseId],
      );
      const event = this.database.connection
        .prepare(
          `UPDATE local_attendance_event SET lifecycle = 'received', server_ingestion_id = ?,
            server_received_at = ?, synchronized_at = ?
           WHERE local_event_id = ? AND lifecycle = 'accepted_pending_sync'`,
        )
        .run(
          response.ingestionId,
          response.receivedAt,
          this.now().toISOString(),
          response.localEventId,
        );
      if (event.changes !== 1) {
        throw new Error("The claimed local attendance event is not pending synchronization.");
      }
    });
  }

  markBlocked(
    syncCommandId: string,
    leaseId: string,
    diagnostic: { readonly code: string; readonly message: string },
  ): void {
    this.transitionLease(
      `UPDATE attendance_outbox SET state = 'blocked', lease_id = NULL, lease_expires_at = NULL,
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
        `UPDATE attendance_outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
          lease_expires_at = NULL, last_error_code = 'LEASE_EXPIRED',
          last_error_message = 'Recovered an expired local attendance lease after restart.',
          updated_at = ?
         WHERE state = 'leased' AND lease_expires_at <= ?`,
      )
      .run(now, now, now);
    return Number(result.changes);
  }

  getStatusCounts(): AttendanceSyncCounts {
    const outboxRows = this.database.connection
      .prepare("SELECT state, COUNT(*) AS count FROM attendance_outbox GROUP BY state")
      .all() as Array<{ state: string; count: number }>;
    const eventRows = this.database.connection
      .prepare("SELECT lifecycle, COUNT(*) AS count FROM local_attendance_event GROUP BY lifecycle")
      .all() as Array<{ lifecycle: string; count: number }>;
    const outboxCount = (state: string) =>
      Number(outboxRows.find((row) => row.state === state)?.count ?? 0);
    return {
      pending: outboxCount("pending"),
      leased: outboxCount("leased"),
      retryWait: outboxCount("retry_wait"),
      blocked: outboxCount("blocked"),
      received: Number(eventRows.find((row) => row.lifecycle === "received")?.count ?? 0),
    };
  }

  private transitionLease(sql: string, parameters: ReadonlyArray<string | null>): void {
    const result = this.database.connection.prepare(sql).run(...parameters);
    if (result.changes !== 1) {
      throw new Error(
        "The attendance outbox lease is missing, expired, or owned by another worker.",
      );
    }
  }
}
