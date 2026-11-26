import { randomUUID } from "node:crypto";

import { LocalDatabase } from "./database";
import { OFFLINE_PIN_PATTERN, type OfflinePinEnrollmentStore } from "./offline-pin-enrollment";

/**
 * Offline PIN v2, "same PIN" model (owner decision 2026-11-15, matching the shifted-cafe floor login as is):
 * a person's offline unlock PIN IS their sign-in PIN. Right after a SUCCESSFUL online sign-in on this till,
 * the main process — which already holds the just-verified username + PIN — asks the server to record an
 * enrollment for this device (the server re-verifies the same credential as a step-up) and then seals a
 * device-bound verifier of that PIN locally. There is no separate offline PIN, no extra screen, and the
 * renderer never handles enrollment.
 */
export interface OfflinePinEnrollmentInput {
  readonly tenantId: string;
  /** The access token the sign-in just issued (authenticates the request). */
  readonly accessToken: string;
  /** The sign-in credential just accepted by the server; re-verified server-side, never stored. */
  readonly username: string;
  readonly pin: string;
  /** The signed-in membership (from the sign-in response), used to skip a redundant re-enrollment. */
  readonly membershipId: string;
}

export type OfflinePinRefreshResult =
  | { readonly status: "enrolled"; readonly verifierVersion: number }
  | { readonly status: "current" }
  | {
      readonly status: "skipped";
      readonly reason: "PIN_FORMAT" | "STORAGE_UNAVAILABLE" | "TILL_NOT_ENROLLED";
    }
  | { readonly status: "failed"; readonly code: OfflinePinEnrollmentErrorCode };

/** Error codes the enrollment journey surfaces to the renderer (as `Error.message` prefix `[CODE]`). */
export type OfflinePinEnrollmentErrorCode =
  | "OFFLINE_PIN_STORAGE_UNAVAILABLE"
  | "OFFLINE_PIN_TILL_NOT_ENROLLED"
  | "OFFLINE_PIN_STEP_UP_FAILED"
  | "OFFLINE_PIN_DISABLED"
  | "OFFLINE_PIN_ENROLLMENT_DENIED"
  | "OFFLINE_PIN_ACCOUNT_LOCKED"
  | "OFFLINE_PIN_NETWORK"
  | "OFFLINE_PIN_FAILED";

export class OfflinePinEnrollmentError extends Error {
  constructor(
    readonly code: OfflinePinEnrollmentErrorCode,
    message: string,
  ) {
    // The code travels in the message because Electron IPC forwards only `message` to the renderer.
    super(`[${code}] ${message}`);
    this.name = "OfflinePinEnrollmentError";
  }
}

export interface OfflinePinEnrollmentResult {
  readonly enrollmentId: string;
  readonly verifierVersion: number;
  readonly enrolledAt: string;
  /** Offline unlock works once the next online bootstrap lists this enrollment for this device. */
  readonly effective: "after_next_bootstrap";
}

type EnrollClient = (input: {
  tenantId: string;
  accessToken: string;
  deviceId: string;
  registerId: string;
  idempotencyKey: string;
  stepUp: { username: string; pin: string };
}) => Promise<{
  membershipId: string;
  enrollmentId: string;
  verifierVersion: number;
  enrolledAt: string;
}>;

const sdkEnrollClient =
  (apiBaseUrl: string): EnrollClient =>
  async (input) => {
    const { createCommerceClient, SDK_VERSION } = await import("@shifted/clothing-commerce-sdk");
    return createCommerceClient({
      baseUrl: apiBaseUrl,
      client: { type: "pos-desktop", version: SDK_VERSION },
      getToken: async () => input.accessToken,
    })
      .withTenant(input.tenantId)
      .enrollOfflinePin({
        idempotencyKey: input.idempotencyKey,
        deviceId: input.deviceId,
        registerId: input.registerId,
        stepUp: input.stepUp,
      });
  };

function classifyServerError(error: unknown): OfflinePinEnrollmentError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  switch (code) {
    case "OFFLINE_PIN_STEP_UP_FAILED":
    case "INVALID_CREDENTIALS":
      return new OfflinePinEnrollmentError(
        "OFFLINE_PIN_STEP_UP_FAILED",
        "The sign-in credential was not accepted by the server. Nothing was enrolled.",
      );
    case "ACCOUNT_LOCKED":
      return new OfflinePinEnrollmentError(
        "OFFLINE_PIN_ACCOUNT_LOCKED",
        "Too many wrong sign-in PINs. Wait and try again. Nothing was enrolled.",
      );
    case "OFFLINE_PIN_DISABLED":
      return new OfflinePinEnrollmentError(
        "OFFLINE_PIN_DISABLED",
        "Offline PIN sign-in is not enabled for this business yet. Nothing was enrolled.",
      );
    case "OFFLINE_PIN_ENROLLMENT_DENIED":
    case "PERMISSION_DENIED":
      return new OfflinePinEnrollmentError(
        "OFFLINE_PIN_ENROLLMENT_DENIED",
        "This account is not allowed to sell offline on this register. Nothing was enrolled.",
      );
    default:
      if (code === "" || code === "NETWORK_ERROR" || code === "TIMEOUT")
        return new OfflinePinEnrollmentError(
          "OFFLINE_PIN_NETWORK",
          "The server could not be reached. Nothing was enrolled; try again when online.",
        );
      return new OfflinePinEnrollmentError(
        "OFFLINE_PIN_FAILED",
        "Offline PIN setup failed. Nothing was enrolled.",
      );
  }
}

/**
 * Offline PIN v2 enrollment, main process only. Order matters: the server records the enrollment FIRST (the
 * server re-verifies the sign-in credential — never a token alone); only then is the device-bound verifier
 * sealed locally. If sealing fails after the server succeeded, the server holds an enrollment with no local
 * verifier, which can unlock nothing; the next sign-in enrols again (superseding it).
 */
export class OfflinePinEnroller {
  private readonly enrollClient: EnrollClient;

  constructor(
    private readonly database: LocalDatabase,
    private readonly enrollments: OfflinePinEnrollmentStore,
    apiBaseUrl: string,
    enrollClient?: EnrollClient,
  ) {
    this.enrollClient = enrollClient ?? sdkEnrollClient(apiBaseUrl);
  }

  /**
   * Enrol this till for the signed-in person using their SIGN-IN PIN. Throws OfflinePinEnrollmentError; the
   * server records the enrollment first, then the verifier is sealed (a crash in between leaves nothing
   * usable). The PIN is never logged, never written to SQLite/outbox, and only sent to the server as the
   * step-up credential it already accepted at sign-in.
   */
  async enroll(input: OfflinePinEnrollmentInput): Promise<OfflinePinEnrollmentResult> {
    if (!OFFLINE_PIN_PATTERN.test(input.pin))
      throw new OfflinePinEnrollmentError(
        "OFFLINE_PIN_FAILED",
        "The sign-in PIN format is not supported.",
      );
    if (!this.enrollments.isAvailable())
      throw new OfflinePinEnrollmentError(
        "OFFLINE_PIN_STORAGE_UNAVAILABLE",
        "OS-protected storage is unavailable; offline sign-in cannot be prepared on this till.",
      );
    const device = this.activeDevice();
    if (!device)
      throw new OfflinePinEnrollmentError(
        "OFFLINE_PIN_TILL_NOT_ENROLLED",
        "This till is not registered yet.",
      );
    let enrolled: Awaited<ReturnType<EnrollClient>>;
    try {
      enrolled = await this.enrollClient({
        tenantId: input.tenantId,
        accessToken: input.accessToken,
        deviceId: device.deviceId,
        registerId: device.registerId,
        idempotencyKey: randomUUID(),
        stepUp: { username: input.username, pin: input.pin },
      });
    } catch (error) {
      throw classifyServerError(error);
    }
    this.enrollments.enroll({
      membershipId: enrolled.membershipId,
      enrollmentId: enrolled.enrollmentId,
      verifierVersion: enrolled.verifierVersion,
      deviceId: device.deviceId,
      pin: input.pin,
    });
    return {
      enrollmentId: enrolled.enrollmentId,
      verifierVersion: enrolled.verifierVersion,
      enrolledAt: enrolled.enrolledAt,
      effective: "after_next_bootstrap",
    };
  }

  /**
   * Called after every successful online sign-in. Never throws and never blocks the sign-in. Skips when this
   * till already holds a sealed verifier for this person that matches the PIN just used (so a normal sign-in
   * does not create a new server version every time); otherwise (first sign-in here, PIN changed online,
   * verifier pruned after revocation/supersede) it enrols again.
   */
  async refreshAfterSignIn(input: OfflinePinEnrollmentInput): Promise<OfflinePinRefreshResult> {
    if (!OFFLINE_PIN_PATTERN.test(input.pin)) return { status: "skipped", reason: "PIN_FORMAT" };
    if (!this.enrollments.isAvailable())
      return { status: "skipped", reason: "STORAGE_UNAVAILABLE" };
    const device = this.activeDevice();
    if (!device) return { status: "skipped", reason: "TILL_NOT_ENROLLED" };
    const existing = this.enrollments.entryFor(input.membershipId);
    if (
      existing &&
      existing.deviceId === device.deviceId &&
      this.enrollments.matches({
        membershipId: input.membershipId,
        enrollmentId: existing.enrollmentId,
        verifierVersion: existing.verifierVersion,
        deviceId: device.deviceId,
        pin: input.pin,
      })
    )
      return { status: "current" };
    try {
      const result = await this.enroll(input);
      return { status: "enrolled", verifierVersion: result.verifierVersion };
    } catch (error) {
      return {
        status: "failed",
        code: error instanceof OfflinePinEnrollmentError ? error.code : "OFFLINE_PIN_FAILED",
      };
    }
  }

  private activeDevice(): { deviceId: string; registerId: string } | null {
    const device = this.database.connection
      .prepare(
        "SELECT device_id, register_id FROM device_state WHERE singleton_id = 1 AND status = 'active'",
      )
      .get() as { device_id: string | null; register_id: string | null } | undefined;
    return device?.device_id && device.register_id
      ? { deviceId: device.device_id, registerId: device.register_id }
      : null;
  }
}
