import { randomUUID } from "node:crypto";

import type { IngestOfflineCustomerResponse } from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import { LocalDatabase } from "./database";
import { SaleHoldOutboxStore } from "./sale-hold-outbox-store";

export interface CustomerOutboxWorkItem {
  readonly syncCommandId: string;
  readonly localCustomerId: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly requestJson: string;
  readonly attempts: number;
  readonly leaseId: string;
}

export const CUSTOMER_DEPENDENCY_REJECTED = "CUSTOMER_DEPENDENCY_REJECTED";
export const CUSTOMER_DEPENDENCY_MISMATCH = "CUSTOMER_DEPENDENCY_MISMATCH";

/**
 * ADR-042 §8: durable leased delivery queue for new customers captured offline — the same lease/retry/
 * blocking semantics as the other outboxes.
 *
 * Dependencies (local schema v19): an installment sale or paydown that names an offline-created customer
 * waits for it. On server acceptance the canonical id is recorded on every dependent in the SAME transaction;
 * it must equal the till's stable local id, otherwise the dependent is held (never relinked). On a final
 * rejection every dependent is held and its outbox row is blocked with deterministic evidence; it is never
 * sent and never re-pointed to another customer, and no duplicate is merged.
 *
 * Retention: the accepted local profile (name + phone) is kept until the NEXT successful sync pass, then
 * purged together with the outbox copy of the command; dependents keep only the display name and the last
 * four phone digits as the receipt/audit snapshot.
 */
export class CustomerOutboxStore {
  constructor(
    private readonly database: LocalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  claimNext(leaseDurationMs: number): CustomerOutboxWorkItem | null {
    return this.database.transaction(() => {
      const now = this.now();
      const nowIso = now.toISOString();
      const candidate = this.database.connection
        .prepare(
          `SELECT sync_command_id FROM customer_outbox
           WHERE state IN ('pending', 'retry_wait') AND next_attempt_at <= ?
           ORDER BY next_attempt_at, created_at LIMIT 1`,
        )
        .get(nowIso) as { sync_command_id: string } | undefined;
      if (!candidate) return null;
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.valueOf() + leaseDurationMs).toISOString();
      const result = this.database.connection
        .prepare(
          `UPDATE customer_outbox SET state = 'leased', attempts = attempts + 1, lease_id = ?,
            lease_expires_at = ?, updated_at = ?
           WHERE sync_command_id = ? AND state IN ('pending', 'retry_wait')`,
        )
        .run(leaseId, leaseExpiresAt, nowIso, candidate.sync_command_id);
      if (result.changes !== 1) return null;
      const raw = this.database.connection
        .prepare(
          `SELECT sync_command_id, local_customer_id, tenant_id, idempotency_key, request_json, attempts
           FROM customer_outbox WHERE sync_command_id = ?`,
        )
        .get(candidate.sync_command_id) as Record<string, string | number>;
      return {
        syncCommandId: String(raw.sync_command_id),
        localCustomerId: String(raw.local_customer_id),
        tenantId: String(raw.tenant_id),
        idempotencyKey: String(raw.idempotency_key),
        requestJson: String(raw.request_json),
        attempts: Number(raw.attempts),
        leaseId,
      };
    });
  }

  releaseForRetry(
    syncCommandId: string,
    leaseId: string,
    nextAttemptAt: string,
    diagnostic?: { readonly code?: string; readonly message?: string },
  ): void {
    this.transition(
      `UPDATE customer_outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
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

  markBlocked(
    syncCommandId: string,
    leaseId: string,
    diagnostic: { readonly code: string; readonly message: string },
  ): void {
    this.transition(
      `UPDATE customer_outbox SET state = 'blocked', lease_id = NULL, lease_expires_at = NULL,
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

  completeDelivery(
    syncCommandId: string,
    leaseId: string,
    response: IngestOfflineCustomerResponse,
  ): void {
    this.database.transaction(() => {
      const row = this.database.connection
        .prepare("SELECT local_customer_id FROM customer_outbox WHERE sync_command_id = ?")
        .get(syncCommandId) as { local_customer_id: string } | undefined;
      if (!row || row.local_customer_id !== response.localCustomerId) {
        throw new Error("The server response does not match the claimed local customer.");
      }
      this.transition(
        `UPDATE customer_outbox SET state = 'delivered', lease_id = NULL, lease_expires_at = NULL,
          server_ingestion_id = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
         WHERE sync_command_id = ? AND state = 'leased' AND lease_id = ?`,
        [response.ingestionId, this.now().toISOString(), syncCommandId, leaseId],
      );
      const resolvedAt = this.now().toISOString();
      // Accepted: keep the profile until the next successful sync (purgeAcceptedProfiles), flag duplicates.
      this.database.connection
        .prepare(
          `UPDATE local_customer SET lifecycle = 'synced', synchronized_at = ?, duplicate_of_customer_id = ?
           WHERE local_customer_id = ?`,
        )
        .run(resolvedAt, response.duplicateOfCustomerId ?? null, response.localCustomerId);
      const sameId = response.customerId === response.localCustomerId;
      this.database.connection
        .prepare(
          `UPDATE local_customer_dependency SET state = ?, canonical_customer_id = ?, hold_code = ?,
             resolved_at = ?
           WHERE customer_sync_command_id = ? AND state = 'waiting'`,
        )
        .run(
          sameId ? "ready" : "held_customer_mismatch",
          response.customerId,
          sameId ? null : CUSTOMER_DEPENDENCY_MISMATCH,
          resolvedAt,
          syncCommandId,
        );
      if (!sameId) {
        this.holdDependents(syncCommandId, CUSTOMER_DEPENDENCY_MISMATCH, resolvedAt);
      }
    });
  }

  /**
   * Final rejection of a customer command: the outbox row is blocked and every dependent installment sale /
   * paydown is held (and its own outbox row blocked) with deterministic evidence, in one transaction.
   */
  markRejected(
    syncCommandId: string,
    leaseId: string,
    diagnostic: { readonly code: string; readonly message: string },
  ): void {
    this.database.transaction(() => {
      this.markBlocked(syncCommandId, leaseId, diagnostic);
      const resolvedAt = this.now().toISOString();
      this.database.connection
        .prepare(
          `UPDATE local_customer_dependency SET state = 'held_customer_rejected', hold_code = ?,
             resolved_at = ?
           WHERE customer_sync_command_id = ? AND state = 'waiting'`,
        )
        .run(CUSTOMER_DEPENDENCY_REJECTED, resolvedAt, syncCommandId);
      this.holdDependents(syncCommandId, CUSTOMER_DEPENDENCY_REJECTED, resolvedAt);
    });
  }

  private holdDependents(customerSyncCommandId: string, code: string, at: string): void {
    const message =
      code === CUSTOMER_DEPENDENCY_REJECTED
        ? "The new customer this depends on was rejected by the server. Kept on this till; not sent."
        : "The server accepted the new customer under a different id. Kept on this till; not relinked.";
    for (const [lane, table] of [
      ["sale", "outbox"],
      ["payment", "payment_outbox"],
    ] as const) {
      this.database.connection
        .prepare(
          `UPDATE ${table} SET state = 'blocked', last_error_code = ?, last_error_message = ?, updated_at = ?
           WHERE state IN ('pending', 'retry_wait') AND sync_command_id IN (
             SELECT dependent_sync_command_id FROM local_customer_dependency
             WHERE dependent_lane = ? AND customer_sync_command_id = ?)`,
        )
        .run(code, message, at, lane, customerSyncCommandId);
    }
    // ADR-042 §4.6: a sale held because its customer was definitively rejected gets a terminal hold command
    // in this same transaction, so its offline sale ordinal can be accounted for and the stock grant can
    // close. (A mismatch is not covered: the server would refuse the hold because the customer exists.)
    if (code === CUSTOMER_DEPENDENCY_REJECTED) {
      const held = this.database.connection
        .prepare(
          `SELECT dependent_sync_command_id AS id FROM local_customer_dependency
           WHERE dependent_lane = 'sale' AND customer_sync_command_id = ?
             AND state = 'held_customer_rejected'`,
        )
        .all(customerSyncCommandId) as Array<{ id: string }>;
      new SaleHoldOutboxStore(this.database, this.now).enqueueForHeldSales(
        held.map((row) => row.id),
        at,
      );
    }
  }

  /**
   * Purge profiles the server accepted in an EARLIER pass (the owner's "clear at the next successful sync"),
   * and redact the outbox copy of their command. Profiles still needed by a waiting dependent are kept.
   * Returns the number of profiles purged.
   */
  purgeAcceptedProfiles(acceptedBefore: string): number {
    return this.database.transaction(() => {
      const rows = this.database.connection
        .prepare(
          `SELECT lc.local_customer_id FROM local_customer lc
           JOIN customer_outbox o ON o.local_customer_id = lc.local_customer_id
           WHERE lc.lifecycle = 'synced' AND lc.synchronized_at < ? AND o.state = 'delivered'
             AND NOT EXISTS (
               SELECT 1 FROM local_customer_dependency d
               WHERE d.local_customer_id = lc.local_customer_id AND d.state = 'waiting')`,
        )
        .all(acceptedBefore) as Array<{ local_customer_id: string }>;
      const now = this.now().toISOString();
      for (const row of rows) {
        this.database.connection
          .prepare(
            `UPDATE customer_outbox SET canonical_command = '{"redacted":true}',
               request_json = '{"redacted":true}', redacted_at = ?, updated_at = ?
             WHERE local_customer_id = ? AND state = 'delivered' AND redacted_at IS NULL`,
          )
          .run(now, now, row.local_customer_id);
        this.database.connection
          .prepare("DELETE FROM local_customer WHERE local_customer_id = ?")
          .run(row.local_customer_id);
      }
      return rows.length;
    });
  }

  getStatusCounts(): {
    pending: number;
    leased: number;
    retryWait: number;
    blocked: number;
    delivered: number;
    heldDependents: number;
  } {
    const rows = this.database.connection
      .prepare("SELECT state, COUNT(*) AS count FROM customer_outbox GROUP BY state")
      .all() as Array<{ state: string; count: number }>;
    const by = (state: string) => Number(rows.find((row) => row.state === state)?.count ?? 0);
    const held = this.database.connection
      .prepare("SELECT COUNT(*) AS count FROM local_customer_dependency WHERE state LIKE 'held_%'")
      .get() as { count: number };
    return {
      pending: by("pending"),
      leased: by("leased"),
      retryWait: by("retry_wait"),
      blocked: by("blocked"),
      delivered: by("delivered"),
      heldDependents: Number(held.count),
    };
  }

  recoverExpiredLeases(): number {
    const now = this.now().toISOString();
    return Number(
      this.database.connection
        .prepare(
          `UPDATE customer_outbox SET state = 'retry_wait', next_attempt_at = ?, lease_id = NULL,
            lease_expires_at = NULL, last_error_code = 'LEASE_EXPIRED', updated_at = ?
           WHERE state = 'leased' AND lease_expires_at <= ?`,
        )
        .run(now, now, now).changes,
    );
  }

  pendingCount(): number {
    const row = this.database.connection
      .prepare(
        "SELECT COUNT(*) AS count FROM customer_outbox WHERE state IN ('pending','leased','retry_wait')",
      )
      .get() as { count: number };
    return Number(row.count);
  }

  private transition(sql: string, parameters: ReadonlyArray<string | null>): void {
    const result = this.database.connection.prepare(sql).run(...parameters);
    if (result.changes !== 1) {
      throw new Error("The customer outbox lease is missing, expired, or owned by another worker.");
    }
  }
}
