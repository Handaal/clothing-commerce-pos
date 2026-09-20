import type { CreateReturnInput, ReturnDetailResponse } from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

export type ReturnIntent = Omit<CreateReturnInput, "idempotencyKey">;
export interface ReturnSession {
  tenantId: string;
  accessToken: string;
}
export type ReturnStage = "prepared" | "return_acknowledged" | "settlement_prepared" | "completed";
/** Renderer projection: canonical acknowledgements, never stored command keys or credentials. */
export interface ReturnWorkflow {
  id: string;
  orderId: string;
  orderReference: string;
  stage: ReturnStage;
  createdAt: string;
  result: ReturnDetailResponse | null;
  outcome: "acknowledged" | "rejected" | null;
}
export interface ReturnReply {
  workflow: ReturnWorkflow | null;
  error?: { code: string; message: string; uncertain: boolean };
}
export interface ReturnsBridge {
  hasPending(): Promise<boolean>;
  inspect(session: ReturnSession): Promise<ReturnReply>;
  start(session: ReturnSession, intent: ReturnIntent): Promise<ReturnReply>;
  recover(session: ReturnSession): Promise<ReturnReply>;
  settle(session: ReturnSession, returnId: string, reference: string): Promise<ReturnReply>;
  finish(session: ReturnSession, workflowId: string): Promise<ReturnReply>;
}
