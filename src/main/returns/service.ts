import type {
  CommerceClient,
  CreateReturnInput,
  ReturnDetailResponse,
  SettleRefundInput,
  TenantCommerceClient,
} from "@shifted/clothing-commerce-sdk" with { "resolution-mode": "import" };
import type { ReturnIntent, ReturnReply, ReturnSession, ReturnsBridge } from "../../shared/returns";
import { boundedText, parseReturnIntent, parseReturnSession, uuid } from "./input";
import { ReturnStore, type WorkflowRow } from "./store";

export interface ReturnServiceOptions {
  networkOnline?: () => boolean;
  clientFactory?: (session: ReturnSession) => Promise<CommerceClient>;
  /** Test-only commit/ack crash seam. Never exposed through IPC or application environment. */
  afterResponse?: (
    stage: "prepared" | "settlement_prepared",
    row: WorkflowRow,
    result: ReturnDetailResponse,
  ) => void;
}
export class ReturnService implements ReturnsBridge {
  private busy = false;
  constructor(
    private readonly store: ReturnStore,
    private readonly apiBaseUrl: string,
    private readonly options: ReturnServiceOptions = {},
  ) {}
  async hasPending(): Promise<boolean> {
    return this.store.active() !== null;
  }
  private online(): void {
    if (this.options.networkOnline?.() === false) throw new Error("CONNECTION_REQUIRED");
  }
  private async authorize(input: ReturnSession) {
    this.online();
    const session = parseReturnSession(input);
    const sdk = await import("@shifted/clothing-commerce-sdk");
    const root = this.options.clientFactory
      ? await this.options.clientFactory(session)
      : sdk.createCommerceClient({
          baseUrl: this.apiBaseUrl,
          client: { type: "pos-desktop", version: "0.1.0" },
          getToken: () => session.accessToken,
        });
    const member = (await root.getMyTenants()).find(
      (tenant) => tenant.tenantId === session.tenantId,
    );
    if (!member) throw new Error("RETURN_SESSION_MISMATCH");
    this.online();
    return {
      client: root.withTenant(session.tenantId),
      scope: {
        apiBaseUrl: this.apiBaseUrl,
        tenantId: session.tenantId,
        membershipId: member.membershipId,
      },
    };
  }
  private match(
    row: WorkflowRow,
    scope: { apiBaseUrl: string; tenantId: string; membershipId: string },
  ): void {
    if (
      row.api_base_url !== scope.apiBaseUrl ||
      row.tenant_id !== scope.tenantId ||
      row.membership_id !== scope.membershipId
    )
      throw new Error("RETURN_SESSION_MISMATCH");
  }
  private async run(
    input: ReturnSession,
    action: (
      context: Awaited<ReturnType<ReturnService["authorize"]>>,
    ) => Promise<WorkflowRow | null>,
  ): Promise<ReturnReply> {
    if (this.busy)
      return {
        workflow: null,
        error: {
          code: "BUSY",
          message: "A connected return operation is already running. Check recovery again.",
          uncertain: true,
        },
      };
    this.busy = true;
    let scope: Awaited<ReturnType<ReturnService["authorize"]>>["scope"] | undefined;
    try {
      const context = await this.authorize(input);
      scope = context.scope;
      const active = this.store.active();
      if (active) this.match(active, scope);
      const row = await action(context);
      return { workflow: row ? this.store.view(row) : null };
    } catch (error) {
      const { ApiHttpError } = await import("@shifted/clothing-commerce-sdk");
      const mismatch = error instanceof Error && error.message === "RETURN_SESSION_MISMATCH";
      let active: WorkflowRow | null = null;
      try {
        active = this.store.active();
      } catch {
        /* fail closed on broken persistence */
      }
      const visible =
        scope &&
        active &&
        active.api_base_url === scope.apiBaseUrl &&
        active.tenant_id === scope.tenantId &&
        active.membership_id === scope.membershipId;
      return {
        workflow: visible ? this.store.view(active!) : null,
        error: {
          code: mismatch
            ? "RETURN_SESSION_MISMATCH"
            : error instanceof ApiHttpError
              ? error.code
              : "CONFIRMATION_REQUIRED",
          message: mismatch
            ? "A previous return belongs to another business, operator or API connection. Restore its original session to recover it."
            : error instanceof ApiHttpError && error.status < 500
              ? error.message
              : "Connection and local persistence are required to confirm this return. Its saved command will be recovered; do not hand back cash again.",
          uncertain: !!active || !(error instanceof ApiHttpError && error.status < 500),
        },
      };
    } finally {
      this.busy = false;
    }
  }
  inspect(session: ReturnSession): Promise<ReturnReply> {
    return this.run(session, async () => this.store.active());
  }
  start(session: ReturnSession, input: ReturnIntent): Promise<ReturnReply> {
    return this.run(session, async ({ client, scope }) => {
      if (this.store.active()) throw new Error("Recover the previous connected workflow first.");
      const intent = parseReturnIntent(input);
      const order = await client.getOrder(intent.orderId);
      this.online();
      const row = this.store.prepare(scope, order.header.orderNumber, intent);
      return this.execute(client, row, true);
    });
  }
  recover(session: ReturnSession): Promise<ReturnReply> {
    return this.run(session, async ({ client }) => {
      const row = this.store.active();
      if (!row) return null;
      if (row.stage === "return_acknowledged") return row;
      return this.execute(client, row, false);
    });
  }
  settle(session: ReturnSession, returnId: string, reference: string): Promise<ReturnReply> {
    return this.run(session, async ({ client, scope }) => {
      returnId = uuid(returnId);
      reference = boundedText(reference);
      let row = this.store.active();
      if (!row) {
        // An older acknowledged pending Return may be settled from canonical history.
        const result = await client.getReturn(returnId);
        const order = await client.getOrder(result.orderId);
        if (result.refund.status !== "pending" || result.refund.method === "electronic")
          throw new Error("Cash settlement is unavailable.");
        this.online();
        row = this.store.prepare(scope, order.header.orderNumber, null, result);
      }
      const acknowledged = this.store.view(row).result;
      if (row.stage !== "return_acknowledged" || acknowledged?.id !== returnId)
        throw new Error("Recover the saved settlement before changing its details.");
      this.online();
      row = this.store.prepareSettlement(row.id, reference);
      return this.execute(client, row, false);
    });
  }
  finish(session: ReturnSession, workflowId: string): Promise<ReturnReply> {
    return this.run(session, async ({ client, scope }) => {
      const row = this.store.get(uuid(workflowId));
      this.match(row, scope);
      if (row.stage === "completed") return row;
      if (row.stage !== "return_acknowledged")
        throw new Error("Confirm the outstanding command first.");
      // Archive acknowledged commands, never claim that a pending refund was paid.
      const result = await client.getReturn(this.store.view(row).result!.id);
      return this.store.finish(row.id, result);
    });
  }
  private async execute(
    client: TenantCommerceClient,
    row: WorkflowRow,
    firstCreation: boolean,
  ): Promise<WorkflowRow> {
    this.online();
    const stage = row.stage;
    if (stage !== "prepared" && stage !== "settlement_prepared")
      throw new Error("Invalid return stage.");
    const command = this.store.command(row);
    let response: ReturnDetailResponse;
    try {
      response =
        stage === "prepared"
          ? await client.createReturn(command as CreateReturnInput)
          : await client.settleRefund(command as SettleRefundInput);
    } catch (error) {
      const { ApiHttpError } = await import("@shifted/clothing-commerce-sdk");
      // Only a definite rejection of the first request can close without a Return.
      // Any replay (including revoked permissions) keeps the saved intent unresolved.
      if (
        firstCreation &&
        error instanceof ApiHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.code !== "IDEMPOTENCY_CONFLICT"
      )
        this.store.rejectFirstCreation(row.id, error.code);
      throw error;
    }
    this.options.afterResponse?.(stage, row, response);
    return this.store.acknowledge(row.id, stage, response);
  }
}
