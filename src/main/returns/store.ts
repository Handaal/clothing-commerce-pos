import { createHash, randomUUID } from "node:crypto";
import type {
  CreateReturnInput,
  ReturnDetailResponse,
  SettleRefundInput,
} from "@shifted/clothing-commerce-sdk" with { "resolution-mode": "import" };
import type { ReturnIntent, ReturnStage, ReturnWorkflow } from "../../shared/returns";
import { LocalDatabase } from "../offline/database";

export interface WorkflowRow {
  id: string;
  api_base_url: string;
  tenant_id: string;
  membership_id: string;
  order_id: string;
  order_reference: string;
  stage: ReturnStage;
  create_command: string | null;
  create_hash: string | null;
  create_key: string | null;
  return_ack: string | null;
  settlement_command: string | null;
  settlement_hash: string | null;
  settlement_key: string | null;
  refund_ack: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  outcome: "acknowledged" | "rejected" | null;
  rejection_code: string | null;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class ReturnStore {
  constructor(
    private readonly db: LocalDatabase,
    private readonly now = () => new Date(),
    private readonly key = () => randomUUID(),
  ) {}
  active(): WorkflowRow | null {
    this.db.assertAccepting();
    return (
      (this.db.connection
        .prepare("SELECT * FROM connected_return_workflow WHERE stage != 'completed'")
        .get() as unknown as WorkflowRow) ?? null
    );
  }
  get(id: string): WorkflowRow {
    this.db.assertAccepting();
    const row = this.db.connection
      .prepare("SELECT * FROM connected_return_workflow WHERE id = ?")
      .get(id) as unknown as WorkflowRow | undefined;
    if (!row) throw new Error("Return workflow not found.");
    return row;
  }
  prepare(
    scope: { apiBaseUrl: string; tenantId: string; membershipId: string },
    orderReference: string,
    intent: ReturnIntent | null,
    known?: ReturnDetailResponse,
  ): WorkflowRow {
    return this.db.transaction(() => {
      if (this.active()) throw new Error("Resolve the previous connected return first.");
      const id = this.key();
      const stamp = this.now().toISOString();
      const command: CreateReturnInput | null = intent
        ? { ...intent, idempotencyKey: this.key() }
        : null;
      if (!command && !known)
        throw new Error("A return command or canonical acknowledgement is required.");
      const serialized = command ? JSON.stringify(command) : null;
      this.db.connection
        .prepare(
          `INSERT INTO connected_return_workflow
        (id,api_base_url,tenant_id,membership_id,order_id,order_reference,stage,create_command,create_hash,create_key,return_ack,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          scope.apiBaseUrl,
          scope.tenantId,
          scope.membershipId,
          command?.orderId ?? known!.orderId,
          orderReference,
          command ? "prepared" : "return_acknowledged",
          serialized,
          serialized ? hash(serialized) : null,
          command?.idempotencyKey ?? null,
          known ? JSON.stringify(known) : null,
          stamp,
          stamp,
        );
      return this.get(id);
    });
  }
  command(row: WorkflowRow): CreateReturnInput | SettleRefundInput {
    const settling = row.stage === "settlement_prepared";
    const text = settling ? row.settlement_command : row.create_command;
    const digest = settling ? row.settlement_hash : row.create_hash;
    if (!text || hash(text) !== digest)
      throw new Error("Stored return command failed integrity verification.");
    const value = JSON.parse(text) as CreateReturnInput | SettleRefundInput;
    if (value.idempotencyKey !== (settling ? row.settlement_key : row.create_key))
      throw new Error("Stored return key mismatch.");
    return value;
  }
  acknowledge(
    id: string,
    expectedStage: "prepared" | "settlement_prepared",
    result: ReturnDetailResponse,
  ): WorkflowRow {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row.stage !== expectedStage || row.order_id !== result.orderId)
        throw new Error("Return acknowledgement does not match workflow.");
      if (expectedStage === "settlement_prepared" && JSON.parse(row.return_ack!).id !== result.id)
        throw new Error("Settlement acknowledgement does not match return.");
      const stamp = this.now().toISOString();
      if (expectedStage === "prepared") {
        this.db.connection
          .prepare(
            "UPDATE connected_return_workflow SET return_ack=?,stage='return_acknowledged',updated_at=? WHERE id=?",
          )
          .run(JSON.stringify(result), stamp, id);
      } else {
        this.db.connection
          .prepare(
            "UPDATE connected_return_workflow SET refund_ack=?,stage='completed',outcome='acknowledged',updated_at=?,completed_at=? WHERE id=?",
          )
          .run(JSON.stringify(result), stamp, stamp, id);
      }
      return this.get(id);
    });
  }
  prepareSettlement(id: string, reference: string): WorkflowRow {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row.stage !== "return_acknowledged")
        throw new Error("Resolve the current return stage first.");
      const result = JSON.parse(row.return_ack!) as ReturnDetailResponse;
      const command: SettleRefundInput = {
        returnId: result.id,
        settlementReference: reference,
        idempotencyKey: this.key(),
      };
      const text = JSON.stringify(command);
      this.db.connection
        .prepare(
          "UPDATE connected_return_workflow SET settlement_command=?,settlement_hash=?,settlement_key=?,stage='settlement_prepared',updated_at=? WHERE id=?",
        )
        .run(text, hash(text), command.idempotencyKey, this.now().toISOString(), id);
      return this.get(id);
    });
  }
  finish(id: string, result: ReturnDetailResponse): WorkflowRow {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row.stage !== "return_acknowledged" || JSON.parse(row.return_ack!).id !== result.id)
        throw new Error("Cannot archive an unconfirmed command.");
      const stamp = this.now().toISOString();
      this.db.connection
        .prepare(
          "UPDATE connected_return_workflow SET refund_ack=?,stage='completed',outcome='acknowledged',updated_at=?,completed_at=? WHERE id=?",
        )
        .run(JSON.stringify(result), stamp, stamp, id);
      return this.get(id);
    });
  }
  rejectFirstCreation(id: string, code: string): WorkflowRow {
    return this.db.transaction(() => {
      if (this.get(id).stage !== "prepared") throw new Error("Invalid rejection stage.");
      const stamp = this.now().toISOString();
      this.db.connection
        .prepare(
          "UPDATE connected_return_workflow SET stage='completed',outcome='rejected',rejection_code=?,updated_at=?,completed_at=? WHERE id=?",
        )
        .run(code, stamp, stamp, id);
      return this.get(id);
    });
  }
  view(row: WorkflowRow): ReturnWorkflow {
    return {
      id: row.id,
      orderId: row.order_id,
      orderReference: row.order_reference,
      stage: row.stage,
      createdAt: row.created_at,
      result:
        row.refund_ack || row.return_ack
          ? (JSON.parse((row.refund_ack ?? row.return_ack)!) as ReturnDetailResponse)
          : null,
      outcome: row.outcome,
    };
  }
}
