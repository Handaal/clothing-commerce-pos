import { createHash, randomUUID } from "node:crypto";

import type {
  CreatePosSaleInput,
  CreatePosSaleResponse,
} from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import type { ConnectedSaleIntent, ConnectedSaleStage } from "../../shared/sales";
import { LocalDatabase } from "../offline/database";

export interface ConnectedSaleRow {
  id: string;
  api_base_url: string;
  tenant_id: string;
  register_id: string;
  idempotency_key: string;
  command_json: string;
  command_hash: string;
  expected_total_minor: number;
  stage: ConnectedSaleStage;
  receipt_json: string | null;
  rejection_code: string | null;
  prepared_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ConnectedSaleScope {
  readonly apiBaseUrl: string;
  readonly tenantId: string;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Durable journal for connected POS sale commands. Mirrors the connected-return workflow: the exact
 * idempotency key and normalized command are persisted BEFORE the network call and retained across
 * process death, so a replay after a crash reuses the original key instead of minting a new one.
 */
export class ConnectedSaleStore {
  constructor(
    private readonly db: LocalDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly key: () => string = () => randomUUID(),
  ) {}

  /** The single unresolved (prepared or accepted-but-unacknowledged) workflow, if any. */
  active(): ConnectedSaleRow | null {
    this.db.assertAccepting();
    return (
      (this.db.connection
        .prepare(
          "SELECT * FROM connected_sale_workflow WHERE stage NOT IN ('acknowledged','rejected')",
        )
        .get() as ConnectedSaleRow | undefined) ?? null
    );
  }

  get(id: string): ConnectedSaleRow {
    this.db.assertAccepting();
    const row = this.db.connection
      .prepare("SELECT * FROM connected_sale_workflow WHERE id = ?")
      .get(id) as ConnectedSaleRow | undefined;
    if (!row) throw new Error("Connected sale workflow not found.");
    return row;
  }

  /** Persist a normalized command with a fresh idempotency key. Fails if one is already unresolved. */
  prepare(scope: ConnectedSaleScope, intent: ConnectedSaleIntent): ConnectedSaleRow {
    return this.db.transaction(() => {
      if (this.active()) throw new Error("Resolve the previous connected sale first.");
      const id = this.key();
      const idempotencyKey = this.key();
      const command: CreatePosSaleInput = { ...intent, idempotencyKey };
      const serialized = JSON.stringify(command);
      const stamp = this.now().toISOString();
      this.db.connection
        .prepare(
          `INSERT INTO connected_sale_workflow
            (id, api_base_url, tenant_id, register_id, idempotency_key, command_json, command_hash,
             expected_total_minor, stage, prepared_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
        )
        .run(
          id,
          scope.apiBaseUrl,
          scope.tenantId,
          intent.registerId,
          idempotencyKey,
          serialized,
          hash(serialized),
          intent.expectedTotalMinor,
          stamp,
          stamp,
        );
      return this.get(id);
    });
  }

  /** The exact persisted command, integrity-checked against its hash and stored idempotency key. */
  command(row: ConnectedSaleRow): CreatePosSaleInput {
    if (hash(row.command_json) !== row.command_hash)
      throw new Error("Stored connected sale command failed integrity verification.");
    const value = JSON.parse(row.command_json) as CreatePosSaleInput;
    if (value.idempotencyKey !== row.idempotency_key)
      throw new Error("Stored connected sale key mismatch.");
    return value;
  }

  markAccepted(id: string, receipt: CreatePosSaleResponse): ConnectedSaleRow {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row.stage !== "prepared" && row.stage !== "accepted")
        throw new Error("Only an unresolved connected sale can be accepted.");
      // Idempotent: a replay that re-observes the same acceptance must not overwrite it.
      if (row.stage === "accepted") return row;
      this.db.connection
        .prepare(
          "UPDATE connected_sale_workflow SET stage='accepted', receipt_json=?, updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(receipt), this.now().toISOString(), id);
      return this.get(id);
    });
  }

  acknowledge(id: string): ConnectedSaleRow {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row.stage === "acknowledged") return row;
      if (row.stage !== "accepted")
        throw new Error("Only an accepted connected sale can be acknowledged.");
      const stamp = this.now().toISOString();
      this.db.connection
        .prepare(
          "UPDATE connected_sale_workflow SET stage='acknowledged', updated_at=?, resolved_at=? WHERE id=?",
        )
        .run(stamp, stamp, id);
      return this.get(id);
    });
  }

  /** Close a workflow the server definitively rejected without committing (first attempt only). */
  reject(id: string, code: string): ConnectedSaleRow {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row.stage !== "prepared")
        throw new Error("Only a prepared connected sale can be rejected.");
      const stamp = this.now().toISOString();
      this.db.connection
        .prepare(
          "UPDATE connected_sale_workflow SET stage='rejected', rejection_code=?, updated_at=?, resolved_at=? WHERE id=?",
        )
        .run(code, stamp, stamp, id);
      return this.get(id);
    });
  }

  receipt(row: ConnectedSaleRow): CreatePosSaleResponse {
    if (!row.receipt_json) throw new Error("Connected sale has no accepted receipt.");
    return JSON.parse(row.receipt_json) as CreatePosSaleResponse;
  }
}
