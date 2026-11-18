import { LocalDatabase } from "./database";

/** The server's answer when it preserved a refused offline command as a sync conflict (ADR-042 §13.5). */
export interface ConflictRecordedAnswer {
  readonly syncStatus: "conflict_recorded";
  readonly ingestionId: string;
  readonly receivedAt: string;
  readonly conflict: { readonly id: string; readonly kind: string; readonly reasonCode: string };
  readonly localPaymentId?: string;
  readonly localEventId?: string;
}

/**
 * Durable, immutable local receipt of a server-reported conflict. Called inside the outbox's delivery
 * transaction, so the outbox transition and the receipt commit (or roll back) together. Exact redelivery of
 * the same answer is a no-op; a different answer for the same command is refused.
 */
export function recordServerConflict(
  database: LocalDatabase,
  now: Date,
  syncCommandId: string,
  commandKind: "customer_payment" | "attendance",
  answer: ConflictRecordedAnswer,
): void {
  const existing = database.connection
    .prepare("SELECT conflict_id FROM server_sync_conflict_receipt WHERE sync_command_id = ?")
    .get(syncCommandId) as { conflict_id: string } | undefined;
  if (existing) {
    if (existing.conflict_id !== answer.conflict.id) {
      throw new Error("The server reported a different conflict for this command.");
    }
    return;
  }
  database.connection
    .prepare(
      `INSERT INTO server_sync_conflict_receipt(
        sync_command_id, command_kind, local_reference, server_ingestion_id, conflict_id,
        conflict_kind, reason_code, server_received_at, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      syncCommandId,
      commandKind,
      answer.localPaymentId ?? answer.localEventId ?? syncCommandId,
      answer.ingestionId,
      answer.conflict.id,
      answer.conflict.kind,
      answer.conflict.reasonCode,
      answer.receivedAt,
      now.toISOString(),
    );
}
