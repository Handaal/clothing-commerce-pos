import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type {
  IngestOfflineCustomerRequest,
  IngestOfflineCustomerResponse,
  IngestOfflineAttendanceInput,
  IngestOfflineAttendanceResponse,
  IngestOfflineCustomerPaymentInput,
  IngestOfflineCustomerPaymentResponse,
  IngestOfflineIntentInput,
  IngestOfflineIntentResponse,
  IngestOfflineReturnInput,
  IngestOfflineReturnResponse,
  IngestOfflineSaleInput,
  IngestOfflineSaleResponse,
  OfflineAttendanceCommand,
  OfflineCustomerPaymentCommand,
  OfflineIntentCommand,
  OfflineReturnCommand,
  OfflineSaleCommand,
} from "@shifted/clothing-commerce-sdk" with { "resolution-mode": "import" };

import type { OfflineSyncStatus } from "../../shared/offline";
import { AttendanceOutboxStore, type AttendanceOutboxWorkItem } from "./attendance-outbox-store";
import { IntentOutboxStore, type IntentOutboxWorkItem } from "./intent-outbox-store";
import { OutboxStore, type OutboxWorkItem } from "./outbox-store";
import { PaymentOutboxStore, type PaymentOutboxWorkItem } from "./payment-outbox-store";
import { ReturnOutboxStore, type ReturnOutboxWorkItem } from "./return-outbox-store";

type IngestOfflineSaleRequest = Omit<IngestOfflineSaleInput, "idempotencyKey">;
type IngestOfflineCustomerPaymentRequest = Omit<
  IngestOfflineCustomerPaymentInput,
  "idempotencyKey"
>;
type IngestOfflineAttendanceRequest = Omit<IngestOfflineAttendanceInput, "idempotencyKey">;
type IngestOfflineReturnRequest = Omit<IngestOfflineReturnInput, "idempotencyKey">;
type IngestOfflineIntentRequest = Omit<IngestOfflineIntentInput, "idempotencyKey">;

const sdk = createRequire(__filename)("@shifted/clothing-commerce-sdk") as {
  ApiContractError: new (...args: never[]) => Error;
  ApiHttpError: new (...args: never[]) => Error & { status: number; code: string };
  ApiNetworkError: new (...args: never[]) => Error;
  SDK_VERSION: string;
  canonicalizeOfflineSaleCommand(command: OfflineSaleCommand): string;
  canonicalizeOfflineCustomerPaymentCommand(command: OfflineCustomerPaymentCommand): string;
  canonicalizeOfflineAttendanceCommand(command: OfflineAttendanceCommand): string;
  canonicalizeOfflineReturnCommand(command: OfflineReturnCommand): string;
  canonicalizeOfflineIntentCommand(command: OfflineIntentCommand): string;
  canonicalizeOfflineSaleHoldCommand?(command: unknown): string;
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
      ingestOfflineAttendance(
        input: IngestOfflineAttendanceRequest & { idempotencyKey: string },
      ): Promise<IngestOfflineAttendanceResponse>;
      ingestOfflineReturn(
        input: IngestOfflineReturnRequest & { idempotencyKey: string },
      ): Promise<IngestOfflineReturnResponse>;
      ingestOfflineIntent(
        input: IngestOfflineIntentRequest & { idempotencyKey: string },
      ): Promise<IngestOfflineIntentResponse>;
      ingestOfflineCustomer?(
        input: IngestOfflineCustomerRequest & { idempotencyKey: string },
      ): Promise<IngestOfflineCustomerResponse>;
      ingestOfflineSaleHold?(input: Record<string, unknown>): Promise<SaleHoldReceipt>;
    };
  };
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const LEASE_DURATION_MS = 30_000;

import type { CustomerOutboxStore, CustomerOutboxWorkItem } from "./customer-outbox-store";
import type {
  SaleHoldOutboxStore,
  SaleHoldReceipt,
  SaleHoldSigner,
  SaleHoldWorkItem,
} from "./sale-hold-outbox-store";

/** The SDK canonicalizer for hold commands (throws when the installed SDK predates ADR-042 §4.6). */
export function canonicalizeSaleHold(command: unknown): string {
  if (!sdk.canonicalizeOfflineSaleHoldCommand) {
    throw new Error("The installed SDK cannot canonicalize offline sale holds.");
  }
  return sdk.canonicalizeOfflineSaleHoldCommand(command);
}
export interface OfflineDeliveryClient {
  deliver(item: OutboxWorkItem): Promise<IngestOfflineSaleResponse>;
  deliverPayment(item: PaymentOutboxWorkItem): Promise<IngestOfflineCustomerPaymentResponse>;
  deliverAttendance(item: AttendanceOutboxWorkItem): Promise<IngestOfflineAttendanceResponse>;
  deliverReturn(item: ReturnOutboxWorkItem): Promise<IngestOfflineReturnResponse>;
  /** Provisional operation intents. Optional so older delivery doubles stay valid; the SDK client implements it. */
  deliverIntent?(item: IntentOutboxWorkItem): Promise<IngestOfflineIntentResponse>;
  deliverCustomer?(item: CustomerOutboxWorkItem): Promise<IngestOfflineCustomerResponse>;
  deliverSaleHold?(item: SaleHoldWorkItem): Promise<SaleHoldReceipt>;
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
  /** The attendance-lane queue, drained alongside the sale outbox on every pass. */
  readonly attendanceOutbox?: AttendanceOutboxStore;
  /** The offline-return queue, drained alongside the sale outbox on every pass. */
  readonly returnOutbox?: ReturnOutboxStore;
  /** The provisional operation-intent queue, drained after the other lanes on every pass. */
  readonly intentOutbox?: IntentOutboxStore;
  readonly customerOutbox?: CustomerOutboxStore;
  /** ADR-042 §4.6 terminal holds for sales whose new customer was rejected, plus their signer. */
  readonly saleHoldOutbox?: SaleHoldOutboxStore;
  readonly saleHoldSigner?: SaleHoldSigner;
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

export function readExactPersistedAttendanceRequest(
  item: AttendanceOutboxWorkItem,
): IngestOfflineAttendanceRequest {
  let request: IngestOfflineAttendanceRequest;
  try {
    request = JSON.parse(item.requestJson) as IngestOfflineAttendanceRequest;
  } catch (error) {
    throw new Error("The persisted offline attendance request JSON is corrupt.", { cause: error });
  }
  if (JSON.stringify(request) !== item.requestJson) {
    throw new Error(
      "The persisted offline attendance request is not in its original representation.",
    );
  }
  const canonical = sdk.canonicalizeOfflineAttendanceCommand(request.command);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (
    canonical !== item.canonicalCommand ||
    hash !== item.payloadHash ||
    request.command.localEventId !== item.localEventId ||
    request.command.syncCommandId !== item.syncCommandId ||
    item.idempotencyKey !== item.syncCommandId ||
    request.signature.credentialId !== item.credentialId
  ) {
    throw new Error(
      "The persisted offline attendance request failed its immutable identity check.",
    );
  }
  return request;
}

export function readExactPersistedReturnRequest(
  item: ReturnOutboxWorkItem,
): IngestOfflineReturnRequest {
  let request: IngestOfflineReturnRequest;
  try {
    request = JSON.parse(item.requestJson) as IngestOfflineReturnRequest;
  } catch (error) {
    throw new Error("The persisted offline return request JSON is corrupt.", { cause: error });
  }
  if (JSON.stringify(request) !== item.requestJson) {
    throw new Error("The persisted offline return request is not in its original representation.");
  }
  const canonical = sdk.canonicalizeOfflineReturnCommand(request.command);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (
    canonical !== item.canonicalCommand ||
    hash !== item.payloadHash ||
    request.command.localReturnId !== item.localReturnId ||
    request.command.syncCommandId !== item.syncCommandId ||
    item.idempotencyKey !== item.syncCommandId ||
    request.signature.credentialId !== item.credentialId
  ) {
    throw new Error("The persisted offline return request failed its immutable identity check.");
  }
  return request;
}

export function readExactPersistedIntentRequest(
  item: IntentOutboxWorkItem,
): IngestOfflineIntentRequest {
  let request: IngestOfflineIntentRequest;
  try {
    request = JSON.parse(item.requestJson) as IngestOfflineIntentRequest;
  } catch (error) {
    throw new Error("The persisted offline intent request JSON is corrupt.", { cause: error });
  }
  if (JSON.stringify(request) !== item.requestJson) {
    throw new Error("The persisted offline intent request is not in its original representation.");
  }
  const canonical = sdk.canonicalizeOfflineIntentCommand(request.command);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (
    canonical !== item.canonicalCommand ||
    hash !== item.payloadHash ||
    request.command.localIntentId !== item.localIntentId ||
    request.command.syncCommandId !== item.syncCommandId ||
    item.idempotencyKey !== item.syncCommandId ||
    request.signature.credentialId !== item.credentialId
  ) {
    throw new Error("The persisted offline intent request failed its immutable identity check.");
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

  deliverAttendance(item: AttendanceOutboxWorkItem): Promise<IngestOfflineAttendanceResponse> {
    const request = readExactPersistedAttendanceRequest(item);
    return this.tenantClient(item.tenantId).ingestOfflineAttendance({
      idempotencyKey: item.idempotencyKey,
      ...request,
    });
  }

  deliverReturn(item: ReturnOutboxWorkItem): Promise<IngestOfflineReturnResponse> {
    const request = readExactPersistedReturnRequest(item);
    return this.tenantClient(item.tenantId).ingestOfflineReturn({
      idempotencyKey: item.idempotencyKey,
      ...request,
    });
  }

  deliverIntent(item: IntentOutboxWorkItem): Promise<IngestOfflineIntentResponse> {
    const request = readExactPersistedIntentRequest(item);
    return this.tenantClient(item.tenantId).ingestOfflineIntent({
      idempotencyKey: item.idempotencyKey,
      ...request,
    });
  }

  deliverSaleHold(item: SaleHoldWorkItem): Promise<SaleHoldReceipt> {
    const client = this.tenantClient(item.tenantId);
    if (!client.ingestOfflineSaleHold) {
      return Promise.reject(new Error("The installed SDK cannot deliver offline sale holds."));
    }
    return client.ingestOfflineSaleHold({
      idempotencyKey: item.syncCommandId,
      ...(JSON.parse(item.requestJson) as Record<string, unknown>),
    });
  }

  deliverCustomer(item: CustomerOutboxWorkItem): Promise<IngestOfflineCustomerResponse> {
    const client = this.tenantClient(item.tenantId);
    if (!client.ingestOfflineCustomer) {
      return Promise.reject(new Error("The installed SDK cannot deliver offline customers."));
    }
    return client.ingestOfflineCustomer({
      idempotencyKey: item.idempotencyKey,
      ...(JSON.parse(item.requestJson) as IngestOfflineCustomerRequest),
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
  private readonly attendanceOutbox: AttendanceOutboxStore | undefined;
  private readonly returnOutbox: ReturnOutboxStore | undefined;
  private readonly intentOutbox: IntentOutboxStore | undefined;

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
    this.attendanceOutbox = options.attendanceOutbox;
    this.returnOutbox = options.returnOutbox;
    this.intentOutbox = options.intentOutbox;
    this.customerOutbox = options.customerOutbox;
    this.saleHoldOutbox = options.saleHoldOutbox;
    this.saleHoldSigner = options.saleHoldSigner;
  }

  private readonly customerOutbox: CustomerOutboxStore | undefined;
  private readonly saleHoldOutbox: SaleHoldOutboxStore | undefined;
  private readonly saleHoldSigner: SaleHoldSigner | undefined;

  /**
   * ADR-042 §4.6: send the terminal hold of every sale whose new customer was rejected. A hold is never an
   * approval request: the server records held_for_reconciliation automatically, or refuses it (blocked,
   * visible in review). A lost response is retried byte-identically and returns the original receipt.
   */
  private async drainSaleHolds(): Promise<void> {
    const holds = this.saleHoldOutbox;
    const signer = this.saleHoldSigner;
    if (!holds || !signer || !this.delivery.deliverSaleHold) return;
    holds.recoverExpiredLeases();
    for (let processed = 0; processed < 10; processed += 1) {
      let item: SaleHoldWorkItem | null;
      try {
        item = holds.claimNext(LEASE_DURATION_MS, signer);
      } catch (error) {
        // Signing unavailable (key locked / SDK too old): nothing changes; try again next pass.
        this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        return;
      }
      if (!item) break;
      this.lastAttemptAt = this.now().toISOString();
      let receipt: SaleHoldReceipt;
      try {
        receipt = await this.delivery.deliverSaleHold(item);
      } catch (error) {
        const failure = classifySyncFailure(error);
        this.lastError = failure.message.slice(0, 500);
        if (failure.kind === "transient") {
          holds.releaseForRetry(
            item.syncCommandId,
            item.leaseId,
            retryAt(this.now(), item.attempts),
            failure,
          );
        } else {
          holds.markBlocked(item.syncCommandId, item.leaseId, failure);
        }
        continue;
      }
      holds.completeDelivery(item.syncCommandId, item.leaseId, receipt);
      this.lastError = null;
    }
  }

  /** ADR-042 §8: new customers first, so anything that later refers to them finds them on the server. */
  private async drainCustomers(): Promise<void> {
    const customers = this.customerOutbox;
    if (!customers || !this.delivery.deliverCustomer) return;
    customers.recoverExpiredLeases();
    // Profiles accepted in an earlier pass are cleared now (owner rule: clear at the next successful sync).
    customers.purgeAcceptedProfiles(this.now().toISOString());
    for (let processed = 0; processed < 10; processed += 1) {
      const item = customers.claimNext(LEASE_DURATION_MS);
      if (!item) break;
      this.lastAttemptAt = this.now().toISOString();
      let response: IngestOfflineCustomerResponse;
      try {
        response = await this.delivery.deliverCustomer(item);
      } catch (error) {
        const failure = classifySyncFailure(error);
        this.lastError = failure.message.slice(0, 500);
        if (failure.kind === "transient") {
          customers.releaseForRetry(
            item.syncCommandId,
            item.leaseId,
            retryAt(this.now(), item.attempts),
            failure,
          );
        } else if (error instanceof sdk.ApiHttpError) {
          // A definitive server rejection: hold every dependent installment sale / paydown with
          // deterministic evidence (never sent, never relinked).
          customers.markRejected(item.syncCommandId, item.leaseId, failure);
        } else {
          // A client-side contract/delivery fault is not a server decision: block the customer command for
          // review but leave its dependents waiting rather than resolving them on a guess.
          customers.markBlocked(item.syncCommandId, item.leaseId, failure);
        }
        continue;
      }
      customers.completeDelivery(item.syncCommandId, item.leaseId, response);
      this.lastError = null;
    }
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
    await this.drainCustomers();
    await this.drainSaleHolds();
    for (let processed = 0; processed < 10; processed += 1) {
      const item = this.outbox.claimNext(LEASE_DURATION_MS);
      // Stop draining SALES when none remain, but fall through to the payment and attendance lanes:
      // a standalone queued payment or attendance event (with no pending sale) must still sync.
      if (!item) break;
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
    await this.drainAttendance();
    await this.drainReturns();
    await this.drainIntents();
  }

  private async drainIntents(): Promise<void> {
    const intents = this.intentOutbox;
    const deliver = this.delivery.deliverIntent?.bind(this.delivery);
    if (!intents || !deliver) return;
    intents.recoverExpiredLeases();
    for (let processed = 0; processed < 10; processed += 1) {
      const item = intents.claimNext(LEASE_DURATION_MS);
      if (!item) return;
      this.lastAttemptAt = this.now().toISOString();
      let response: IngestOfflineIntentResponse;
      try {
        response = await deliver(item);
      } catch (error) {
        const failure = classifySyncFailure(error);
        this.lastError = failure.message.slice(0, 500);
        if (failure.kind === "transient") {
          intents.releaseForRetry(
            item.syncCommandId,
            item.leaseId,
            retryAt(this.now(), item.attempts),
            failure,
          );
        } else {
          intents.markBlocked(item.syncCommandId, item.leaseId, failure);
        }
        continue;
      }
      intents.completeDelivery(item.syncCommandId, item.leaseId, response);
      this.lastError = null;
    }
  }

  private async drainReturns(): Promise<void> {
    const returns = this.returnOutbox;
    if (!returns) return;
    returns.recoverExpiredLeases();
    for (let processed = 0; processed < 10; processed += 1) {
      const item = returns.claimNext(LEASE_DURATION_MS);
      if (!item) return;
      this.lastAttemptAt = this.now().toISOString();
      let response: IngestOfflineReturnResponse;
      try {
        response = await this.delivery.deliverReturn(item);
      } catch (error) {
        const failure = classifySyncFailure(error);
        this.lastError = failure.message.slice(0, 500);
        if (failure.kind === "transient") {
          returns.releaseForRetry(
            item.syncCommandId,
            item.leaseId,
            retryAt(this.now(), item.attempts),
            failure,
          );
        } else {
          returns.markBlocked(item.syncCommandId, item.leaseId, failure);
        }
        continue;
      }
      returns.completeDelivery(item.syncCommandId, item.leaseId, response);
      this.lastError = null;
    }
  }

  private async drainAttendance(): Promise<void> {
    const attendance = this.attendanceOutbox;
    if (!attendance) return;
    attendance.recoverExpiredLeases();
    for (let processed = 0; processed < 10; processed += 1) {
      const item = attendance.claimNext(LEASE_DURATION_MS);
      if (!item) return;
      this.lastAttemptAt = this.now().toISOString();
      let response: IngestOfflineAttendanceResponse;
      try {
        response = await this.delivery.deliverAttendance(item);
      } catch (error) {
        const failure = classifySyncFailure(error);
        this.lastError = failure.message.slice(0, 500);
        if (failure.kind === "transient") {
          attendance.releaseForRetry(
            item.syncCommandId,
            item.leaseId,
            retryAt(this.now(), item.attempts),
            failure,
          );
        } else {
          attendance.markBlocked(item.syncCommandId, item.leaseId, failure);
        }
        continue;
      }
      attendance.completeDelivery(item.syncCommandId, item.leaseId, response);
      this.lastError = null;
    }
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
    const attendance = this.attendanceOutbox?.getStatusCounts();
    const returns = this.returnOutbox?.getStatusCounts();
    const intents = this.intentOutbox?.getStatusCounts();
    const customers = this.customerOutbox?.getStatusCounts();
    return {
      pending:
        counts.pending +
        (payments?.pending ?? 0) +
        (attendance?.pending ?? 0) +
        (returns?.pending ?? 0) +
        (intents?.pending ?? 0) +
        (customers?.pending ?? 0),
      leased:
        counts.leased +
        (payments?.leased ?? 0) +
        (attendance?.leased ?? 0) +
        (returns?.leased ?? 0) +
        (intents?.leased ?? 0) +
        (customers?.leased ?? 0),
      retryWait:
        counts.retryWait +
        (payments?.retryWait ?? 0) +
        (attendance?.retryWait ?? 0) +
        (returns?.retryWait ?? 0) +
        (intents?.retryWait ?? 0) +
        (customers?.retryWait ?? 0),
      blocked:
        counts.blocked +
        (payments?.blocked ?? 0) +
        (attendance?.blocked ?? 0) +
        (returns?.blocked ?? 0) +
        (intents?.blocked ?? 0) +
        (customers?.blocked ?? 0),
      synced:
        counts.synced +
        (payments?.synced ?? 0) +
        (attendance?.received ?? 0) +
        (returns?.synced ?? 0) +
        (intents?.received ?? 0) +
        (customers?.delivered ?? 0),
      needsReconciliation: counts.needsReconciliation + (returns?.needsReconciliation ?? 0),
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
