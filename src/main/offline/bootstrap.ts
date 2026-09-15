import os from "node:os";

import type { OfflineBootstrapResponse } from "@shifted/clothing-commerce-sdk" with {
  "resolution-mode": "import",
};

import type { OfflineBootstrapInput, OfflineBootstrapResult } from "../../shared/offline";
import { OfflineAuthorityStore } from "./authority-store";
import { DeviceKeyStore } from "./device-key";

function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value
      .split("-", 1)[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export class OfflineBootstrapService {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly authority: OfflineAuthorityStore,
    private readonly keys: DeviceKeyStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async bootstrap(input: OfflineBootstrapInput): Promise<OfflineBootstrapResult> {
    const { createCommerceClient, SDK_VERSION } = await import("@shifted/clothing-commerce-sdk");
    const now = this.now().toISOString();
    const publicKey = await this.keys.ensureKeyReady();
    const preparation = this.authority.prepareEnrollment(
      input.tenantId,
      input.registerId,
      publicKey,
      now,
    );
    const client = createCommerceClient({
      baseUrl: this.apiBaseUrl,
      client: { type: "pos-desktop", version: SDK_VERSION },
      getToken: async () => input.accessToken,
    }).withTenant(input.tenantId);

    if (!preparation.existingDevice) {
      const enrolled = await client.enrollPosDevice({
        idempotencyKey: preparation.idempotencyKey,
        registerId: input.registerId,
        installationId: preparation.installationId,
        displayName: input.displayName,
        publicKey: {
          algorithm: preparation.publicKey.algorithm,
          encoding: preparation.publicKey.encoding,
          value: preparation.publicKey.value,
        },
        clientVersion: SDK_VERSION,
        platform: process.platform,
        osVersion: os.release(),
      });
      if (enrolled.publicKeyFingerprint !== publicKey.fingerprint) {
        throw new Error("The enrolled server credential does not match the local public key.");
      }
      this.authority.completeEnrollment(enrolled, input.tenantId, this.now().toISOString());
      if (enrolled.status !== "active") throw new Error("The enrolled device is not active.");
    }

    const device = this.authority.getActiveDevice();
    const bootstrapKey = this.authority.prepareBootstrapIdempotencyKey();
    const bootstrap = await client.createOfflineBootstrap({
      idempotencyKey: bootstrapKey,
      deviceId: device.deviceId,
      registerId: device.registerId,
    });
    this.assertCompatible(bootstrap, SDK_VERSION);
    const releasedProjectionCount = this.authority.installBootstrap(
      bootstrap,
      this.now().toISOString(),
    );
    return {
      deviceId: bootstrap.deviceId,
      registerId: bootstrap.registerId,
      grantId: bootstrap.grantId,
      snapshotId: bootstrap.snapshotId,
      acceptedUntil: bootstrap.acceptedUntil,
      catalogValidUntil: bootstrap.catalogValidUntil,
      catalogItemCount: bootstrap.catalog.reduce(
        (total, product) => total + product.variants.length,
        0,
      ),
      releasedProjectionCount,
    };
  }

  private assertCompatible(bootstrap: OfflineBootstrapResponse, sdkVersion: string): void {
    if (compareVersions(sdkVersion, bootstrap.minimumClientVersion) < 0) {
      throw new Error(
        `Offline bootstrap requires client ${bootstrap.minimumClientVersion}; installed SDK is ${sdkVersion}.`,
      );
    }
  }
}
