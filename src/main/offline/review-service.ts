import type {
  ReviewActionRecord,
  ReviewActionResult,
  ReviewItem,
  ReviewLane,
  ReviewQuery,
  ReviewResolutionInput,
  ReviewRetryInput,
  ReviewStatus,
} from "../../shared/offline";
import { LocalDatabase } from "./database";
import { OfflineIntentService } from "./intent-service";

interface LaneSpec {
  readonly outbox: string;
  readonly local: string;
  readonly localKey: string;
  /** SQL expression (over alias l) producing a safe display label. */
  readonly label: string;
  /** Extra safe evidence columns (alias l), as [evidence key, SQL expression]. */
  readonly evidence: ReadonlyArray<readonly [string, string]>;
  /** SQL expression (alias l) for the server's automatic disposition, when the lane has one. */
  readonly disposition?: string;
}

// Every offline lane shares the same outbox column set (sync_command_id, state, attempts, errors…); only
// the local fact table differs. Evidence is limited to identifiers, minor-unit amounts and reasons — never
// signatures, keys, canonical bytes or customer PII.
const LANES: Record<ReviewLane, LaneSpec> = {
  sale: {
    outbox: "outbox",
    local: "local_sale",
    localKey: "local_sale_id",
    label: "l.local_receipt_id",
    evidence: [
      ["totalMinor", "l.total_minor"],
      ["acceptedAt", "l.accepted_at"],
      ["reconciliationReason", "l.reconciliation_reason"],
    ],
  },
  payment: {
    outbox: "payment_outbox",
    local: "local_customer_payment",
    localKey: "local_payment_id",
    label: "'customer_payment'",
    evidence: [
      ["amountMinor", "l.amount_minor"],
      ["acceptedAt", "l.accepted_at"],
    ],
  },
  attendance: {
    outbox: "attendance_outbox",
    local: "local_attendance_event",
    localKey: "local_event_id",
    label: "l.event_type",
    evidence: [["eventAt", "l.event_at"]],
  },
  return: {
    outbox: "return_outbox",
    local: "local_return",
    localKey: "local_return_id",
    label: "'offline_return'",
    evidence: [
      ["returnGrantId", "l.return_grant_id"],
      ["refundAmountMinor", "l.refund_amount_minor"],
      ["reconciliationReason", "l.reconciliation_reason"],
    ],
  },
  intent: {
    outbox: "intent_outbox",
    local: "local_intent",
    localKey: "local_intent_id",
    label: "l.operation",
    evidence: [
      ["subjectId", "l.subject_id"],
      ["dependsOn", "l.depends_on_sync_command_id"],
      ["acceptedAt", "l.accepted_at"],
      ["serverOutcome", "l.server_disposition_code"],
      ["policyVersion", "l.server_policy_version"],
      ["serverDecidedAt", "l.server_decided_at"],
    ],
    disposition: "l.server_disposition",
  },
};

const LANE_NAMES = Object.keys(LANES) as ReviewLane[];
const ATTENTION: ReadonlySet<ReviewStatus> = new Set([
  "blocked",
  "needs_review",
  "retry_wait",
  "rejected",
  "policy_blocked",
]);

function deriveStatus(
  outboxState: string,
  lifecycle: string,
  disposition: string | null,
): ReviewStatus {
  switch (outboxState) {
    case "pending":
      return "queued";
    case "leased":
      return "syncing";
    case "retry_wait":
      return "retry_wait";
    case "blocked":
      return "blocked";
    default:
      // Automatic server disposition (intent lane). No state here waits for a person.
      if (disposition === "applied") return "accepted";
      if (disposition === "rejected") return "rejected";
      if (disposition === "needs_reconciliation") return "needs_review";
      if (disposition === "blocked_policy") return "policy_blocked";
      if (lifecycle === "needs_reconciliation") return "needs_review";
      if (lifecycle === "received") return "server_received";
      return "accepted";
  }
}

export class ReviewError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "ACTION_NOT_ALLOWED" | "INPUT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

/**
 * The shared OPERATOR RECONCILIATION center over every offline lane (not an approval desk). It reads
 * durable local state only (restart-safe by construction), shows the server's automatic outcome for
 * each command, and supports exactly one operator action, audited append-only in `review_action` and
 * idempotent by caller-supplied actionId:
 *   - retry: re-queue the EXACT same signed command of a transport-BLOCKED item (immutable columns are
 *     untouched; the server's idempotency makes replay safe). Decided or in-flight items can never be
 *     retried, and a server rejection / conflict / policy block can never be overridden from here.
 * The former "resolution request" (asking a manager to decide) was removed with the owner's no-human-
 * approval rule; the method remains only so an older renderer gets a deterministic, audited refusal.
 */
export class OfflineReviewService {
  constructor(
    private readonly database: LocalDatabase,
    _intents: OfflineIntentService | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(query: ReviewQuery = {}): ReviewItem[] {
    const lanes = query.lane && query.lane !== "all" ? [query.lane] : LANE_NAMES;
    const search = query.search?.trim().toLowerCase().slice(0, 100) ?? "";
    const items: ReviewItem[] = [];
    for (const lane of lanes) {
      for (const row of this.readLane(lane)) {
        const item = this.toItem(lane, row);
        if (query.status && query.status !== "all") {
          if (
            query.status === "attention"
              ? !ATTENTION.has(item.status)
              : item.status !== query.status
          )
            continue;
        }
        if (
          search &&
          ![item.syncCommandId, item.localId, item.label, item.lastErrorCode ?? ""].some((value) =>
            value.toLowerCase().includes(search),
          )
        )
          continue;
        items.push(item);
      }
    }
    return items.sort((left, right) =>
      left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0,
    );
  }

  retry(input: ReviewRetryInput): ReviewActionResult {
    return this.database.transaction(() => {
      const prior = this.priorAction(input.actionId, input.lane, input.syncCommandId, "retry");
      if (prior) return prior;
      const spec = LANES[input.lane];
      const row = this.database.connection
        .prepare(`SELECT state FROM ${spec.outbox} WHERE sync_command_id = ?`)
        .get(input.syncCommandId) as { state: string } | undefined;
      if (!row) throw new ReviewError("NOT_FOUND", "The offline command does not exist.");
      if (row.state !== "blocked") {
        return this.audit(input.actionId, input.lane, input.syncCommandId, "retry", null, {
          outcome: "refused",
          detail: `Only a blocked command can be retried (current state: ${row.state}).`,
          related: null,
        });
      }
      const nowIso = this.now().toISOString();
      // Exact replay: only scheduling columns change; the signed command is immutable (DB triggers).
      const result = this.database.connection
        .prepare(
          `UPDATE ${spec.outbox} SET state = 'retry_wait', next_attempt_at = ?, updated_at = ?
           WHERE sync_command_id = ? AND state = 'blocked'`,
        )
        .run(nowIso, nowIso, input.syncCommandId);
      if (Number(result.changes) !== 1) {
        throw new ReviewError(
          "ACTION_NOT_ALLOWED",
          "The command changed state; refresh and retry.",
        );
      }
      return this.audit(input.actionId, input.lane, input.syncCommandId, "retry", null, {
        outcome: "requeued",
        detail: null,
        related: null,
      });
    });
  }

  /** Retired: there is no human approval workflow. Always a deterministic, audited refusal. */
  requestResolution(input: ReviewResolutionInput): ReviewActionResult {
    const note = input.note.trim().slice(0, 1000) || null;
    return this.database.transaction(() => {
      const prior = this.priorAction(
        input.actionId,
        input.lane,
        input.syncCommandId,
        "resolution_request",
      );
      if (prior) return prior;
      if (this.readLane(input.lane, input.syncCommandId).length === 0) {
        throw new ReviewError("NOT_FOUND", "The offline command does not exist.");
      }
      return this.audit(
        input.actionId,
        input.lane,
        input.syncCommandId,
        "resolution_request",
        note,
        {
          outcome: "refused",
          detail:
            "Manager review was removed: the server decides automatically. Reconcile here or redo the action online.",
          related: null,
        },
      );
    });
  }

  private readLane(lane: ReviewLane, syncCommandId?: string): Array<Record<string, unknown>> {
    const spec = LANES[lane];
    const evidence = spec.evidence
      .map(([, expression], index) => `${expression} AS ev_${index}`)
      .join(", ");
    return this.database.connection
      .prepare(
        `SELECT o.sync_command_id, l.${spec.localKey} AS local_id, ${spec.label} AS label,
          o.state, l.lifecycle, ${spec.disposition ?? "NULL"} AS disposition, o.attempts,
          o.created_at, o.updated_at, o.server_ingestion_id,
          l.server_received_at, o.last_error_code, o.last_error_message, o.payload_hash, ${evidence}
         FROM ${spec.outbox} o JOIN ${spec.local} l ON l.${spec.localKey} = o.${spec.localKey}
         ${syncCommandId ? "WHERE o.sync_command_id = ?" : ""}
         ORDER BY o.created_at DESC LIMIT 500`,
      )
      .all(...(syncCommandId ? [syncCommandId] : [])) as Array<Record<string, unknown>>;
  }

  private toItem(lane: ReviewLane, row: Record<string, unknown>): ReviewItem {
    const spec = LANES[lane];
    const status = deriveStatus(
      String(row.state),
      String(row.lifecycle),
      row.disposition === null || row.disposition === undefined ? null : String(row.disposition),
    );
    const syncCommandId = String(row.sync_command_id);
    const actions = this.actionsFor(lane, syncCommandId);
    // Only a transport-blocked command may be resent unchanged. Server decisions are final here.
    const allowedActions: Array<ReviewItem["allowedActions"][number]> =
      status === "blocked" ? ["retry"] : [];
    const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
    return {
      lane,
      syncCommandId,
      localId: String(row.local_id),
      label: String(row.label),
      status,
      attempts: Number(row.attempts),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      serverIngestionId: text(row.server_ingestion_id),
      serverReceivedAt: text(row.server_received_at),
      lastErrorCode: text(row.last_error_code),
      lastErrorMessage: text(row.last_error_message),
      payloadHash: String(row.payload_hash),
      evidence: spec.evidence.flatMap(([key], index) => {
        const value = text(row[`ev_${index}`]);
        return value === null ? [] : [{ key, value }];
      }),
      allowedActions,
      actions,
    };
  }

  private actionsFor(lane: ReviewLane, syncCommandId: string): ReviewActionRecord[] {
    const rows = this.database.connection
      .prepare(
        `SELECT action_id, action, outcome, outcome_detail, note, related_sync_command_id, created_at
         FROM review_action WHERE lane = ? AND sync_command_id = ? ORDER BY created_at, action_id`,
      )
      .all(lane, syncCommandId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      actionId: String(row.action_id),
      action: row.action as ReviewActionRecord["action"],
      outcome: row.outcome as ReviewActionRecord["outcome"],
      outcomeDetail: row.outcome_detail ?? null,
      note: row.note ?? null,
      relatedSyncCommandId: row.related_sync_command_id ?? null,
      createdAt: String(row.created_at),
    }));
  }

  private priorAction(
    actionId: string,
    lane: ReviewLane,
    syncCommandId: string,
    action: ReviewActionRecord["action"],
  ): ReviewActionResult | null {
    const row = this.database.connection
      .prepare(
        `SELECT lane, sync_command_id, action, outcome, outcome_detail, related_sync_command_id
         FROM review_action WHERE action_id = ?`,
      )
      .get(actionId) as Record<string, string | null> | undefined;
    if (!row) return null;
    if (row.lane !== lane || row.sync_command_id !== syncCommandId || row.action !== action) {
      throw new ReviewError("INPUT_INVALID", "The action id was already used for another action.");
    }
    return {
      actionId,
      outcome: row.outcome as ReviewActionResult["outcome"],
      detail: row.outcome_detail ?? null,
      relatedSyncCommandId: row.related_sync_command_id ?? null,
    };
  }

  private audit(
    actionId: string,
    lane: ReviewLane,
    syncCommandId: string,
    action: ReviewActionRecord["action"],
    note: string | null,
    result: {
      outcome: ReviewActionResult["outcome"];
      detail: string | null;
      related: string | null;
    },
  ): ReviewActionResult {
    this.database.connection
      .prepare(
        `INSERT INTO review_action(action_id, lane, sync_command_id, action, operator_label, note,
          outcome, outcome_detail, related_sync_command_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actionId,
        lane,
        syncCommandId,
        action,
        this.operatorLabel(),
        note,
        result.outcome,
        result.detail,
        result.related,
        this.now().toISOString(),
      );
    return {
      actionId,
      outcome: result.outcome,
      detail: result.detail,
      relatedSyncCommandId: result.related,
    };
  }

  private operatorLabel(): string | null {
    const row = this.database.connection
      .prepare(
        `SELECT g.operator_membership_id FROM catalog_snapshot c
         JOIN offline_grant g ON g.grant_id = c.grant_id WHERE c.state = 'active'`,
      )
      .get() as { operator_membership_id: string } | undefined;
    return row?.operator_membership_id ?? null;
  }
}
