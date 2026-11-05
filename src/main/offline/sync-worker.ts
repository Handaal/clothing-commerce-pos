import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type {
  IngestOfflineCustomerPaymentInput,
  IngestOfflineCustomerPaymentResponse,
  IngestOfflineSaleInput,
  IngestOfflineSaleResponse,
  OfflineCustomerPaymentCommand,
  OfflineSaleCommand,
} from "@shifted/clothing-commerce-sdk" with { "resolution-mode": "import" };

import type { OfflineSyncStatus } from "../../shared/offline";
import { OutboxStore, type OutboxWorkItem } from "./outbox-store";
import { PaymentOutboxStore, type PaymentOutboxWorkItem } from "./payment-outbox-store";

type IngestOfflineSaleRequest = Omit<IngestOfflineSaleInput, "idempotencyKey">;
type IngestOfflineCustomerPaymentRequest = Omit<
  IngestOfflineCustomerPaymentInput,
  "idempotencyKey"
>;

const sdk = createRequire(__filename)("@shifted/clothing-commerce-sdk") as {
  ApiContractError: new (...args: never[]) => Error;
  ApiHttpError: new (...args: never[]) => Error & { status: number; code: string };
  ApiNetworkError: new (...args: never[]) => Error;
  SDK_VERSION: string;
  canonicalizeOfflineSaleCommand(command: OfflineSaleCommand): string;
  canonicalizeOfflineCustomerPaymentCommand(command: OfflineCustomerPaymentCommand): string;
  createCommerceClient(options: {
    baseUrl: string;
    client: { type: "pos-desktop"; version: string };
  }): {
    withTenant(tenantId: string): {
      ingestOfflineSale(
        input: IngestOfflineSaleRequest & { idempotencyKey: string },
      ): Promise<IngestOfflineSaleResponse>;
      ingestOfflineCustomerPayment(
        input: IngestOfflineCustomerPaymentRequest & { idempotencyKey: string },
      ): Promise<IngestOfflineCustomerPaymentResponse>;
    };
  };
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const LEASE_DURATION_MS = 30_000;

export interface OfflineDeliveryClient {
  deliver(item: OutboxWorkItem): Promise<IngestOfflineSaleResponse>;
  deliverPayment(item: PaymentOutboxWorkItem): Promise<IngestOfflineCustomerPaymentResponse>;
}

export interface SyncWorkerTestSeam {
  afterServerCommit?(
    item: OutboxWorkItem,
    response: IngestOfflineSaleResponse,
  ): void | Promise<void>;
}

export interface OfflineSyncWorkerOptions {
  readonly now?: () => Date;
  readonly networkOnline?: () => boolean;
  readonly pollIntervalMs?: number;
  readonly testSeam?: SyncWorkerTestSeam;
  /** The payment-lane queue, drained alongside the sale outbox on every pass. */
  readonly paymentOutbox?: PaymentOutboxStore;
}

export function readExactPersistedRequest(item: OutboxWorkItem): IngestOfflineSaleRequest {
  let request: IngestOfflineSaleRequest;
  try {
    request = JSON.parse(item.requestJson) as IngestOfflineSaleRequest;
  } catch (error) {
    throw new Error("The persisted offline request JSON is corrupt.", { cause: error });
  }
  if (JSON.stringify(request) !== item.requestJson) {
    throw new Error("The persisted offline request is not in its original compact representation.");
  }
  const canonical = sdk.canonicalizeOfflineSaleCommand(request.command);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (
    canonical !== item.canonicalCommand ||
    hash !== item.payloadHash ||
    request.command.localSaleId !== item.localSaleId ||
    request.command.syncCommandId !== item.syncCommandId ||
    item.idempotencyKey !== item.syncCommandId ||
    request.signature.credentialId !== item.credentialId
  ) {
    throw new Error("The persisted offline request failed its immutable identity check.");
  }
  return request;
}

export function readExactPersistedPaymentRequest(
  item: PaymentOutboxWorkItem,
): IngestOfflineCustomerPaymentRequest {
  let request: IngestOfflineCustomerPaymentRequest;
  try {
    request = JSON.parse(item.requestJson) as IngestOfflineCustomerPaymentRequest;
  } catch (error) {
    throw new Error("The persisted offline payment request JSON is corrupt.", { cause: error });
  }
  if (JSON.stringify(request) !== item.requestJson) {
    throw new Error("The persisted offline payment request is not in its original representation.");
  }
  const canonical = sdk.canonicalizeOfflineCustomerPaymentCommand(request.command);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (
    canonical !== item.canonicalCommand ||
    hash !== item.payloadHash ||
    request.command.localPaymentId !== item.localPaymentId ||
    request.command.syncCommandId !== item.syncCommandId ||
    item.idempotencyKey !== item.syncCommandId ||
    request.signature.credentialId !== item.credentialId
  ) {
    throw new Error("The persisted offline payment request failed its immutable identity check.");
  }
  return request;
}

export class SdkOfflineDeliveryClient implements OfflineDeliveryClient {
  constructor(private readonly apiBaseUrl: string) {}

  private tenantClient(tenantId: string) {
    return sdk
      .createCommerceClient({
        baseUrl: this.apiBaseUrl,
        client: { type: "pos-desktop", version: sdk.SDK_VERSION },
      })
      .withTenant(tenantId);
  }

  deliver(item: OutboxWorkItem): Promise<IngestOfflineSaleResponse> {
    const request = readExactPersistedRequest(item);
    return this.tenantClient(item.tenantId).ingestOfflineSale({
      idempotencyKey: item.idempotencyKey,
      ...request,
    });
  }

  deliverPayment(item: PaymentOutboxWorkItem): Promise<IngestOfflineCustomerPaymentResponse> {
    const request = readExactPersistedPaymentRequest(item);
    return this.tenantClient(item.tenantId).ingestOfflineCustomerPayment({
      idempotencyKey: item.idempotencyKey,
      ...request,
    });
  }
}

export type SyncFailure =
  | { readonly kind: "transient"; readonly code: string; readonly message: string }
  | { readonly kind: "blocked"; readonly code: string; readonly message: string };

export function classifySyncFailure(error: unknown): SyncFailure {
  if (error instanceof sdk.ApiNetworkError) {
    return { kind: "transient", code: "NETWORK_UNAVAILABLE", message: error.message };
  }
  if (error instanceof sdk.ApiHttpError) {
    if (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    ) {
      return { kind: "transient", code: error.code, message: error.message };
    }
    return { kind: "blocked", code: error.code, message: error.message };
  }
  if (error instanceof sdk.ApiContractError) {
    return { kind: "blocked", code: "CONTRACT_ERROR", message: error.message };
  }
  return {
    kind: "blocked",
    code: "DELIVERY_ERROR",
    message: error instanceof Error ? error.message : "Unknown offline delivery failure.",
  };
}

export function retryAt(now: Date, attempts: number): string {
  const delay = Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
  return new Date(now.valueOf() + delay).toISOString();
}

export class OfflineSyncWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private lastAttemptAt: string | null = null;
  private lastError: string | null = null;
  private readonly now: () => Date;
  private readonly networkOnline: () => boolean;
  private readonly pollIntervalMs: number;
  private readonly paymentOutbox: PaymentOutboxStore | undefined;

  constructor(
    private readonly outbox: OutboxStore,
    private readonly delivery: OfflineDeliveryClient,
    options: OfflineSyncWorkerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.networkOnline = options.networkOnline ?? (() => true);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.testSeam = options.testSeam;
    this.paymentOutbox = options.paymentOutbox;
  }

  private readonly testSeam: SyncWorkerTestSeam | undefined;

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  requestRun(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async runOnce(): Promise<void> {
    if (!this.networkOnline()) return;
    // A fast restart can occur before a crashed worker's lease expires. Recover on every pass so
    // that command becomes eligible once its lease deadline arrives, not only during startup.
    this.outbox.recoverExpiredLeases();
    for (let processed = 0; processed < 10; processed += 1) {
      const item = this.outbox.claimNext(LEASE_DURATION_MS);
      if (!item) return;
      this.lastAttemptAt = this.now().toISOString();
      let response: IngestOfflineSaleResponse;
      try {
        response = await this.delivery.deliver(item);
      } catch (error) {
        const failure = classifySyncFailure(error);
        this.lastError = failure.message.slice(0, 500);
        if (failure.kind === "transient") {
          this.outbox.releaseForRetry(
            item.syncCommandId,
            item.leaseId,
            retryAt(this.now(), item.attempts),
            failure,
          );
        } else {
          this.outbox.markBlocked(item.syncCommandId, item.leaseId, failure);
        }
        continue;
      }
      await this.testSeam?.afterServerCommit?.(item, response);
      this.outbox.completeDelivery(item.syncCommandId, item.leaseId, response);
      this.lastError = null;
    }
    await this.drainPayments();
  }

  private async drainPayments(): Promise<void> {
    const payments = this.paymentOutbox;
    if (!payments) return;
    payments.recoverExpiredLeases();
    for (let processed = 0; processed < 10; processed += 1) {
      const item = payments.claimNext(LEASE_DURATION_MS);
      if (!item) return;
      this.lastAttemptAt = this.now().toISOString();
      let response: IngestOfflineCustomerPaymentResponse;
      try {
        response = await this.delivery.deliverPayment(item);
      } catch (error) {
        const failure = classifySyncFailure(error);
        this.lastError = failure.message.slice(0, 500);
        if (failure.kind === "transient") {
          payments.releaseForRetry(
            item.syncCommandId,
            item.leaseId,
            retryAt(this.now(), item.attempts),
            failure,
          );
        } else {
          payments.markBlocked(item.syncCommandId, item.leaseId, failure);
        }
        continue;
      }
      payments.completeDelivery(item.syncCommandId, item.leaseId, response);
      this.lastError = null;
    }
  }

  getStatus(): OfflineSyncStatus {
    const counts = this.outbox.getStatusCounts();
    const payments = this.paymentOutbox?.getStatusCounts();
    return {
      pending: counts.pending + (payments?.pending ?? 0),
      leased: counts.leased + (payments?.leased ?? 0),
      retryWait: counts.retryWait + (payments?.retryWait ?? 0),
      blocked: counts.blocked + (payments?.blocked ?? 0),
      synced: counts.synced + (payments?.synced ?? 0),
      needsReconciliation: counts.needsReconciliation,
      networkOnline: this.networkOnline(),
      synchronizing: this.running !== undefined,
      lastAttemptAt: this.lastAttemptAt,
      lastError: this.lastError,
    };
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.requestRun()
        .catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message.slice(0, 500) : "Sync failed.";
        })
        .finally(() => this.schedule(this.pollIntervalMs));
    }, delay);
    this.timer.unref?.();
  }
}
