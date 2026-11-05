import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Local PIN hashing with Node's built-in scrypt — no native deps, no external libraries. Stored
// format is "<saltHex>:<hashHex>", matching the shifted-cafe reference POS byte-for-byte so the model
// is identical. Unlike the server-provisioned offline roster, this verifier is NOT device-bound: these
// accounts are created and live on this one terminal, so there is nothing to bind across devices.

const KEY_LENGTH = 32;

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(pin, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
