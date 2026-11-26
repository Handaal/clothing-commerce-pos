import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type { OfflineIntentCommand } from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import {
  OFFLINE_INTENT_OPERATIONS,
  type AcceptedOfflineIntent,
  type LocalIntent,
  type LocalIntentsState,
  type OfflineIntentInput,
  type OfflineIntentOperation,
  type OfflineIntentPayloadObject,
  type OfflineReadiness,
} from "../../shared/offline";
import { LocalDatabase } from "./database";
import { DeviceKeyStore } from "./device-key";
import { OfflineAcceptanceError } from "./offline-service";

const { canonicalizeOfflineIntentCommand } = createRequire(__filename)(
  "@shifted/clothing-commerce-sdk",
) as { canonicalizeOfflineIntentCommand(command: OfflineIntentCommand): string };

const KNOWN_OPERATIONS = new Set<string>(OFFLINE_INTENT_OPERATIONS);

interface IntentAuthority {
  readonly grant_id: string;
  readonly device_id: string;
  readonly credential_id: string;
  readonly register_id: string;
  readonly operator_membership_id: string;
  readonly payload_json: string;
}

/** Operations the stored bootstrap payload's register policy opts into. Unknown values are dropped. */
export function enabledIntentOperations(grantPayloadJson: string | null | undefined) {
  if (!grantPayloadJson) return [] as OfflineIntentOperation[];
  try {
    const parsed = JSON.parse(grantPayloadJson) as { policy?: { intentOperations?: unknown } };
    const values = parsed.policy?.intentOperations;
    if (!Array.isArray(values)) return [];
    return values.filter(
      (value): value is OfflineIntentOperation =>
        typeof value === "string" && KNOWN_OPERATIONS.has(value),
    );
  } catch {
    return [];
  }
}

/**
 * Offline operation intents for the management desks (inventory receive/adjust/count, supplier and staff
 * requests, settings / self-revocation requests).
 *
 * The till may only RECORD an intent: a signed immutable command is written to `local_intent` +
 * `intent_outbox` in ONE SQLite transaction before any network, under the active grant and only for an
 * operation the register's server policy opts into. Nothing local is changed beyond that record: no
 * projected stock, no supplier balance, no role, no setting. On sync the SERVER decides automatically
 * (applied / rejected / needs_reconciliation / blocked_policy); no person approves anything. The decision
 * is stored write-once with the local intent. The renderer never sees keys or signatures.
 */
export class OfflineIntentService {
  constructor(
    private readonly database: LocalDatabase,
    private readonly keys: DeviceKeyStore,
    private readonly readiness: () => OfflineReadiness,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getEnabledOperations(): OfflineIntentOperation[] {
    return enabledIntentOperations(this.getAuthority()?.payload_json);
  }

  recordIntent(input: OfflineIntentInput): AcceptedOfflineIntent {
    return this.database.transaction(() => {
      const readiness = this.readiness();
      if (!readiness.ready) throw new OfflineAcceptanceError(readiness.reason, readiness.message);
      const authority = this.getAuthority();
      if (!authority) throw new OfflineAcceptanceError("GRANT_MISSING", "No active grant exists.");
      if (!enabledIntentOperations(authority.payload_json).includes(input.operation)) {
        throw new OfflineAcceptanceError(
          "INTENT_NOT_ENABLED",
          "This action is not enabled for offline recording on this register.",
        );
      }
      if (input.dependsOnSyncCommandId !== null) {
        const parent = this.database.connection
          .prepare("SELECT 1 FROM intent_outbox WHERE sync_command_id = ?")
          .get(input.dependsOnSyncCommandId);
        if (!parent) {
          throw new OfflineAcceptanceError(
            "INPUT_INVALID",
            "The intent depends on an unknown local intent.",
          );
        }
      }
      const acceptedAt = this.now().toISOString();
      const localIntentId = randomUUID();
      const syncCommandId = randomUUID();
      const command = {
        schemaVersion: 1,
        localIntentId,
        syncCommandId,
        grantId: authority.grant_id,
        deviceId: authority.device_id,
        registerId: authority.register_id,
        operatorMembershipId: authority.operator_membership_id,
        subjectId: input.subjectId,
        baseVersion: input.baseVersion,
        dependsOnSyncCommandId: input.dependsOnSyncCommandId,
        acceptedAt,
        operation: input.operation,
        payload: input.payload,
      } as unknown as OfflineIntentCommand;
      let canonicalCommand: string;
      try {
        // The SDK canonicalizer validates the payload against the operation's server schema.
        canonicalCommand = canonicalizeOfflineIntentCommand(command);
      } catch {
        throw new OfflineAcceptanceError(
          "INPUT_INVALID",
          "The offline request is incomplete or invalid for this action.",
        );
      }
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
          `INSERT INTO local_intent(
            local_intent_id, grant_id, operator_membership_id, operation, subject_id, base_version,
            depends_on_sync_command_id, payload_json, accepted_at, lifecycle, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted_pending_sync', ?)`,
        )
        .run(
          localIntentId,
          authority.grant_id,
          authority.operator_membership_id,
          input.operation,
          input.subjectId,
          input.baseVersion,
          input.dependsOnSyncCommandId,
          JSON.stringify(input.payload),
          acceptedAt,
          acceptedAt,
        );
      this.database.connection
        .prepare(
          `INSERT INTO intent_outbox(
            sync_command_id, local_intent_id, idempotency_key, canonical_command, payload_hash,
            signature_base64, credential_id, request_json, state, next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          syncCommandId,
          localIntentId,
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
        localIntentId,
        syncCommandId,
        operation: input.operation,
        acceptedAt,
      };
    });
  }

  getLocalIntents(): LocalIntentsState {
    const rows = this.database.connection
      .prepare(
        `SELECT i.local_intent_id, o.sync_command_id, i.operation, i.subject_id, i.payload_json,
          i.accepted_at, i.lifecycle, o.state, i.server_received_at, o.last_error_code,
          i.server_disposition, i.server_disposition_code
         FROM local_intent i JOIN intent_outbox o ON o.local_intent_id = i.local_intent_id
         ORDER BY i.accepted_at DESC, i.local_intent_id DESC LIMIT 50`,
      )
      .all() as Array<Record<string, string | null>>;
    const recent: LocalIntent[] = rows.map((row) => ({
      localIntentId: String(row.local_intent_id),
      syncCommandId: String(row.sync_command_id),
      operation: row.operation as OfflineIntentOperation,
      subjectId: row.subject_id ?? null,
      payload: safePayload(row.payload_json),
      acceptedAt: String(row.accepted_at),
      lifecycle: row.lifecycle as LocalIntent["lifecycle"],
      outboxState: row.state as LocalIntent["outboxState"],
      serverReceivedAt: row.server_received_at ?? null,
      lastErrorCode: row.last_error_code ?? null,
      disposition: (row.server_disposition ?? null) as LocalIntent["disposition"],
      dispositionCode: row.server_disposition_code ?? null,
    }));
    const pending = this.database.connection
      .prepare(
        "SELECT COUNT(*) AS count FROM intent_outbox WHERE state IN ('pending','leased','retry_wait')",
      )
      .get() as { count: number };
    return {
      enabledOperations: this.getEnabledOperations(),
      pending: Number(pending.count),
      recent,
    };
  }

  private getAuthority(): IntentAuthority | undefined {
    return this.database.connection
      .prepare(
        `SELECT g.grant_id, d.device_id, d.credential_id, g.register_id, g.operator_membership_id,
          g.payload_json
         FROM device_state d
         JOIN catalog_snapshot c ON c.state = 'active'
         JOIN offline_grant g ON g.grant_id = c.grant_id
         WHERE d.singleton_id = 1`,
      )
      .get() as IntentAuthority | undefined;
  }
}

function safePayload(value: string | null): OfflineIntentPayloadObject {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as OfflineIntentPayloadObject)
      : {};
  } catch {
    return {};
  }
}
