import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEVICE_KEY_FILENAME = "offline-device-key.protected.json";

export interface OsSecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  encryptStringAsync?(plaintext: string): Promise<Buffer>;
  decryptStringAsync?(
    encrypted: Buffer,
  ): Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>;
}

export interface PublicDeviceKey {
  readonly algorithm: "Ed25519";
  readonly encoding: "spki_der_base64";
  readonly value: string;
  readonly fingerprint: string;
}

interface ProtectedKeyRecord extends PublicDeviceKey {
  readonly encryptedPrivateKeyBase64: string;
}

interface ProtectedKeyFile {
  readonly version: 1;
  readonly active: ProtectedKeyRecord;
  readonly pendingRotation?: ProtectedKeyRecord;
}

export class DeviceKeyUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeviceKeyUnavailableError";
  }
}

function isProtectedKeyRecord(value: unknown): value is ProtectedKeyRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.algorithm === "Ed25519" &&
    record.encoding === "spki_der_base64" &&
    typeof record.value === "string" &&
    /^[a-f0-9]{64}$/.test(String(record.fingerprint)) &&
    typeof record.encryptedPrivateKeyBase64 === "string"
  );
}

function parseKeyFile(serialized: string): ProtectedKeyFile {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new DeviceKeyUnavailableError("The protected device-key file is not valid JSON.", {
      cause: error,
    });
  }
  if (!value || typeof value !== "object") {
    throw new DeviceKeyUnavailableError("The protected device-key file has an invalid shape.");
  }
  const file = value as Record<string, unknown>;
  if (
    file.version !== 1 ||
    !isProtectedKeyRecord(file.active) ||
    (file.pendingRotation !== undefined && !isProtectedKeyRecord(file.pendingRotation))
  ) {
    throw new DeviceKeyUnavailableError("The protected device-key file has an invalid shape.");
  }
  return file as unknown as ProtectedKeyFile;
}

export class DeviceKeyStore {
  readonly path: string;
  private cachedPrivateKey: KeyObject | undefined;
  private cachedRecord: ProtectedKeyRecord | undefined;

  constructor(
    userDataPath: string,
    private readonly secureStorage: OsSecureStorage,
    private readonly durabilityBarrier: () => Promise<void> = async () => {},
  ) {
    this.path = path.join(userDataPath, DEVICE_KEY_FILENAME);
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  async initializeIfPresent(): Promise<void> {
    if (this.exists()) await this.loadActiveKeyReady();
  }

  async ensureKeyReady(): Promise<PublicDeviceKey> {
    if (this.cachedRecord) return this.publicPart(this.cachedRecord);
    if (this.exists()) {
      await this.loadActiveKeyReady();
      return this.publicPart(this.cachedRecord!);
    }
    if (
      !this.secureStorage.isAsyncEncryptionAvailable ||
      !this.secureStorage.encryptStringAsync ||
      !this.secureStorage.decryptStringAsync
    ) {
      return this.ensureKey();
    }
    if (!(await this.secureStorage.isAsyncEncryptionAvailable())) {
      throw new DeviceKeyUnavailableError("OS-backed device-key encryption is unavailable.");
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ format: "der", type: "spki" });
    const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
    const value = publicDer.toString("base64");
    const encryptedPrivateKeyBase64 = (
      await this.secureStorage.encryptStringAsync(privateDer.toString("base64"))
    ).toString("base64");
    await this.durabilityBarrier();
    const active: ProtectedKeyRecord = {
      algorithm: "Ed25519",
      encoding: "spki_der_base64",
      value,
      fingerprint: createHash("sha256").update(publicDer).digest("hex"),
      encryptedPrivateKeyBase64,
    };
    this.writeKeyFile({ version: 1, active });
    this.cachedPrivateKey = privateKey;
    this.cachedRecord = active;
    return this.publicPart(active);
  }

  ensureKey(): PublicDeviceKey {
    if (this.cachedRecord) return this.publicPart(this.cachedRecord);
    if (this.exists()) return this.loadPublicKey();
    this.assertEncryptionAvailable();
    const active = this.createProtectedKey();
    this.writeKeyFile({ version: 1, active });
    this.cacheValidated(active);
    return this.publicPart(active);
  }

  loadPublicKey(): PublicDeviceKey {
    if (this.cachedRecord) {
      this.assertEncryptionAvailable();
      const persisted = this.readAndValidateShapeOnly().active;
      if (JSON.stringify(persisted) !== JSON.stringify(this.cachedRecord)) {
        throw new DeviceKeyUnavailableError("The protected device-key file changed unexpectedly.");
      }
      return this.publicPart(this.cachedRecord);
    }
    const file = this.readAndValidate();
    this.validatePrivateKey(file.active);
    return this.publicPart(file.active);
  }

  signCanonical(canonicalCommand: string): string {
    const record = this.readAndValidate().active;
    const privateKey =
      this.cachedRecord?.fingerprint === record.fingerprint && this.cachedPrivateKey
        ? this.cachedPrivateKey
        : this.loadPrivateKey(record);
    const signature = sign(null, Buffer.from(canonicalCommand, "utf8"), privateKey);
    const publicKey = createPublicKey({
      key: Buffer.from(record.value, "base64"),
      format: "der",
      type: "spki",
    });
    if (!verify(null, Buffer.from(canonicalCommand, "utf8"), publicKey, signature)) {
      throw new DeviceKeyUnavailableError(
        "The protected device key failed its signing self-check.",
      );
    }
    return signature.toString("base64");
  }

  beginRotation(): PublicDeviceKey {
    const file = this.readAndValidate();
    if (file.pendingRotation) {
      this.validatePrivateKey(file.pendingRotation);
      return this.publicPart(file.pendingRotation);
    }
    const pendingRotation = this.createProtectedKey();
    this.writeKeyFile({ ...file, pendingRotation });
    return this.publicPart(pendingRotation);
  }

  commitRotation(expectedFingerprint: string): PublicDeviceKey {
    const file = this.readAndValidate();
    if (!file.pendingRotation || file.pendingRotation.fingerprint !== expectedFingerprint) {
      throw new DeviceKeyUnavailableError("No matching protected rotation key is available.");
    }
    this.validatePrivateKey(file.pendingRotation);
    this.writeKeyFile({ version: 1, active: file.pendingRotation });
    return this.publicPart(file.pendingRotation);
  }

  private assertEncryptionAvailable(): void {
    if (!this.secureStorage.isEncryptionAvailable()) {
      throw new DeviceKeyUnavailableError("OS-backed device-key encryption is unavailable.");
    }
  }

  private createProtectedKey(): ProtectedKeyRecord {
    this.assertEncryptionAvailable();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ format: "der", type: "spki" });
    const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
    const value = publicDer.toString("base64");
    return {
      algorithm: "Ed25519",
      encoding: "spki_der_base64",
      value,
      fingerprint: createHash("sha256").update(publicDer).digest("hex"),
      encryptedPrivateKeyBase64: this.secureStorage
        .encryptString(privateDer.toString("base64"))
        .toString("base64"),
    };
  }

  private readAndValidate(): ProtectedKeyFile {
    this.assertEncryptionAvailable();
    if (!this.exists()) throw new DeviceKeyUnavailableError("The enrolled device key is missing.");
    try {
      return parseKeyFile(readFileSync(this.path, "utf8"));
    } catch (error) {
      if (error instanceof DeviceKeyUnavailableError) throw error;
      throw new DeviceKeyUnavailableError("The protected device-key file could not be read.", {
        cause: error,
      });
    }
  }

  private loadPrivateKey(record: ProtectedKeyRecord) {
    try {
      const decrypted = this.secureStorage.decryptString(
        Buffer.from(record.encryptedPrivateKeyBase64, "base64"),
      );
      const privateKey = createPrivateKey({
        key: Buffer.from(decrypted, "base64"),
        format: "der",
        type: "pkcs8",
      });
      if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
      return privateKey;
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new DeviceKeyUnavailableError(
        `The protected device key is unavailable or corrupt.${detail}`,
        { cause: error },
      );
    }
  }

  private async loadActiveKeyReady(): Promise<void> {
    const file = this.readAndValidateShapeOnly();
    if (
      !this.secureStorage.isAsyncEncryptionAvailable ||
      !this.secureStorage.encryptStringAsync ||
      !this.secureStorage.decryptStringAsync
    ) {
      this.validatePrivateKey(file.active);
      return;
    }
    if (!(await this.secureStorage.isAsyncEncryptionAvailable())) {
      throw new DeviceKeyUnavailableError("OS-backed device-key encryption is unavailable.");
    }
    try {
      const encrypted = Buffer.from(file.active.encryptedPrivateKeyBase64, "base64");
      const decrypted = await this.secureStorage.decryptStringAsync(encrypted);
      const privateKey = createPrivateKey({
        key: Buffer.from(decrypted.result, "base64"),
        format: "der",
        type: "pkcs8",
      });
      this.assertKeyMatches(file.active, privateKey);
      let active = file.active;
      if (decrypted.shouldReEncrypt) {
        const encryptedPrivateKeyBase64 = (
          await this.secureStorage.encryptStringAsync(decrypted.result)
        ).toString("base64");
        await this.durabilityBarrier();
        active = {
          ...file.active,
          encryptedPrivateKeyBase64,
        };
        this.writeKeyFile({ ...file, active });
      }
      this.cachedPrivateKey = privateKey;
      this.cachedRecord = active;
    } catch (error) {
      throw new DeviceKeyUnavailableError("The protected device key is unavailable or corrupt.", {
        cause: error,
      });
    }
  }

  private validatePrivateKey(record: ProtectedKeyRecord): void {
    const privateKey = this.loadPrivateKey(record);
    this.assertKeyMatches(record, privateKey);
    this.cachedPrivateKey = privateKey;
    this.cachedRecord = record;
  }

  private assertKeyMatches(record: ProtectedKeyRecord, privateKey: KeyObject): void {
    const derivedPublic = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    const storedPublic = Buffer.from(record.value, "base64");
    const fingerprint = createHash("sha256").update(storedPublic).digest("hex");
    if (!derivedPublic.equals(storedPublic) || fingerprint !== record.fingerprint) {
      throw new DeviceKeyUnavailableError(
        "The protected device key does not match its public identity.",
      );
    }
  }

  private cacheValidated(record: ProtectedKeyRecord): void {
    this.validatePrivateKey(record);
  }

  private readAndValidateShapeOnly(): ProtectedKeyFile {
    if (!this.exists()) throw new DeviceKeyUnavailableError("The enrolled device key is missing.");
    try {
      return parseKeyFile(readFileSync(this.path, "utf8"));
    } catch (error) {
      if (error instanceof DeviceKeyUnavailableError) throw error;
      throw new DeviceKeyUnavailableError("The protected device-key file could not be read.", {
        cause: error,
      });
    }
  }

  private publicPart(record: ProtectedKeyRecord): PublicDeviceKey {
    return {
      algorithm: record.algorithm,
      encoding: record.encoding,
      value: record.value,
      fingerprint: record.fingerprint,
    };
  }

  private writeKeyFile(file: ProtectedKeyFile): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}
