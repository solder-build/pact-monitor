import { createHash } from "node:crypto";
import nacl from "tweetnacl";

/**
 * Serialize records array to a deterministic JSON string (sorted keys).
 */
export function serializeRecords(records: unknown[]): string {
  return JSON.stringify(records, Object.keys(records[0] as object).sort());
}

/**
 * Create an Ed25519 signature for a payload string.
 * Returns base64-encoded signature.
 */
export function createSignature(payload: string, secretKey: Uint8Array): string {
  const hash = createHash("sha256").update(payload).digest();
  const signature = nacl.sign.detached(hash, secretKey);
  return Buffer.from(signature).toString("base64");
}

/**
 * Verify an Ed25519 signature for a payload string.
 */
export function verifySignature(
  payload: string,
  signatureBase64: string,
  publicKey: Uint8Array,
): boolean {
  const hash = createHash("sha256").update(payload).digest();
  const signature = Buffer.from(signatureBase64, "base64");
  return nacl.sign.detached.verify(hash, signature, publicKey);
}
