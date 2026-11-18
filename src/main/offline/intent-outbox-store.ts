import { randomUUID } from "node:crypto";

import type { IngestOfflineIntentResponse } from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import { LocalDatabase } from "./database";

export interface IntentOutboxWorkItem {
  readonly syncCommandId: string;
  readonly localIntentId: string;
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

export interface IntentSyncCounts {
  readonly pending: number;
  readonly leased: number;
  readonly retryWait: number;
  readonly blocked: number;
  readonly received: number;
}

/**
 * Durable leased delivery queue for provisional offline operation intents — the intent-lane sibling of
 * OutboxStore / AttendanceOutboxStore, with identical lease/retry/blocking semantics. On delivery it marks
 * the local intent `received` and stores, write-once, the server's AUTOMATIC disposition (applied /
 * rejected / needs_reconciliation / blocked_policy) and ingestion id. A transport-blocked intent stays
 * blocked until an operator takes the audited exact-retry action; it is never silently dropped.
 */
export class IntentOutboxStore {
  constructor(
    private readonly database: LocalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  claimNext(leaseDurationMs: number): IntentOutboxWorkItem | null {
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1_000 ||
      leaseDurationMs > 600_000
    ) {
      throw new Error("Intent outbox lease duration must be between one second and ten minutes.");
    }
    return this.database.transaction(() => {
      const now = this.now();
      const nowIso = now.toISOString();
      const candidate = this.database.connection
        .prepare(
          `SELECT o.sync_command_id FROM intent_outbox o
           JOIN local_intent i ON i.local_intent_id = o.local_intent_id
           WHERE o.state IN ('pending', 'retry_wait') AND o.next_attempt_at <= ?
             -- Dependency ordering: never send a child before its local parent intent is delivered.
             AND (i.depends_on_sync_command_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM intent_outbox p
               WHERE p.sync_command_id = i.depends_on_sync_command_id AND p.state <> 'delivered'))
           ORDER BY o.created_at, o.next_attempt_at LIMIT 1`,
        )
        .get(nowIso) as { sync_command_id: string } | undefined;
      if (!candidate) return null;
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.valueOf() + leaseDurationMs).toISOString();
      const result = this.database.connection
        .prepare(
          `UPDATE intent_outbox SET state = 'leased', attempts = attempts + 1,
            lease_id = ?, lease_expires_at = ?, updated_at = ?
           WHERE sync_command_id = ? AND state IN ('pending', 'retry_wait') AND next_attempt_at <= ?`,
        )
        .run(leaseId, leaseExpiresAt, nowIso, candidate.sync_command_id, nowIso);
      if (result.changes !== 1) return null;
      const raw = this.database.connection
        .prepare(
          `SELECT o.sync_command_id, o.local_intent_id, g.tenant_id, o.idempotency_key,
            o.canonical_command, o.payload_hash, o.request_json, o.credential_id,
            o.attempts, o.lease_id, o.lease_expires_at
           FROM intent_outbox o
           JOIN local_intent e ON e.local_intent_id = o.local_intent_id
           JOIN offline_grant g ON g.grant_id = e.grant_id
           WHERE o.sync_command_id = ?`,
        )
        .get(candidate.sync_command_id) as Record<string, string | number>;
      return {
        syncCommandId: String(raw.sync_command_id),
        localIntentId: String(raw.local_intent_id),
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
      `UPDATE intent_outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
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
    response: IngestOfflineIntentResponse,
  ): void {
    this.database.transaction(() => {
      const command = this.database.connection
        .prepare("SELECT local_intent_id FROM intent_outbox WHERE sync_command_id = ?")
        .get(syncCommandId) as { local_intent_id: string } | undefined;
      if (!command || command.local_intent_id !== response.localIntentId) {
        throw new Error("The server response does not match the claimed local intent.");
      }
      this.transitionLease(
        `UPDATE intent_outbox SET state = 'delivered', lease_id = NULL, lease_expires_at = NULL,
          server_ingestion_id = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
         WHERE sync_command_id = ? AND state = 'leased' AND lease_id = ?`,
        [response.ingestionId, this.now().toISOString(), syncCommandId, leaseId],
      );
      const event = this.database.connection
        .prepare(
          `UPDATE local_intent SET lifecycle = 'received', server_ingestion_id = ?,
            server_received_at = ?, synchronized_at = ?, server_disposition = ?,
            server_disposition_code = ?, server_disposition_detail_json = ?,
            server_policy_version = ?, server_decided_at = ?
           WHERE local_intent_id = ? AND lifecycle = 'accepted_pending_sync'`,
        )
        .run(
          response.ingestionId,
          response.receivedAt,
          this.now().toISOString(),
          response.intent.disposition,
          response.intent.code,
          JSON.stringify(response.intent.detail ?? {}),
          response.intent.policyVersion,
          response.intent.decidedAt,
          response.localIntentId,
        );
      if (event.changes !== 1) {
        throw new Error("The claimed local intent is not pending synchronization.");
      }
    });
  }

  markBlocked(
    syncCommandId: string,
    leaseId: string,
    diagnostic: { readonly code: string; readonly message: string },
  ): void {
    this.transitionLease(
      `UPDATE intent_outbox SET state = 'blocked', lease_id = NULL, lease_expires_at = NULL,
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
        `UPDATE intent_outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
          lease_expires_at = NULL, last_error_code = 'LEASE_EXPIRED',
          last_error_message = 'Recovered an expired local intent lease after restart.',
          updated_at = ?
         WHERE state = 'leased' AND lease_expires_at <= ?`,
      )
      .run(now, now, now);
    return Number(result.changes);
  }

  getStatusCounts(): IntentSyncCounts {
    const outboxRows = this.database.connection
      .prepare("SELECT state, COUNT(*) AS count FROM intent_outbox GROUP BY state")
      .all() as Array<{ state: string; count: number }>;
    const eventRows = this.database.connection
      .prepare("SELECT lifecycle, COUNT(*) AS count FROM local_intent GROUP BY lifecycle")
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
      throw new Error("The intent outbox lease is missing, expired, or owned by another worker.");
    }
  }
}
