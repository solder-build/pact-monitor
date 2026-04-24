import {
  fixDecoderSize,
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getI64Decoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU16Decoder,
  getU32Decoder,
  getU64Decoder,
  getU8Decoder,
  type Address,
  type Decoder,
  type ProgramDerivedAddress,
  type ReadonlyUint8Array,
} from '@solana/kit';
import { PACT_INSURANCE_PROGRAM_ADDRESS } from '../programs/pactInsurance.js';

export const CLAIM_SEED = new Uint8Array([
  // "claim"
  0x63, 0x6c, 0x61, 0x69, 0x6d,
]);

export const CLAIM_DISCRIMINATOR = 4;

/**
 * Layout mirror of the Rust `state::Claim` (bytemuck, repr(C)).
 *
 * WP-15 — decoder deferred from WP-11.1 per plan addendum. Field order tracks
 * the offset assert pinned in `src/state.rs` (`policy` at byte offset 8).
 *
 * `callId` stores the 32-byte SHA-256 digest of the agent-provided `call_id`
 * UTF-8 bytes, NOT the raw string (state.rs:308 / WP-4 addendum #9). Use this
 * field as the deterministic identity for cross-client derivation; the raw
 * call_id is the input passed to `submit_claim` and is not retained on-chain.
 */
export type Claim = {
  discriminator: number;
  pad: ReadonlyArray<number>;
  policy: Address;
  pool: Address;
  agent: Address;
  /** SHA-256 digest of the original `call_id` UTF-8 bytes. */
  callId: ReadonlyArray<number>;
  evidenceHash: ReadonlyArray<number>;
  paymentAmount: bigint;
  refundAmount: bigint;
  callTimestamp: bigint;
  createdAt: bigint;
  resolvedAt: bigint;
  latencyMs: number;
  statusCode: number;
  /** `TriggerType` raw byte: 0 Timeout, 1 Error, 2 SchemaMismatch, 3 LatencySla. */
  triggerType: number;
  /** `ClaimStatus` raw byte: 0 Pending, 1 Approved, 2 Rejected. */
  status: number;
  bump: number;
  padTail: ReadonlyArray<number>;
  /**
   * WP-11.1 — 64-byte reserved pad. Project-wide convention (Rick Q3
   * 2026-04-24) so one future layout extension can land without a
   * state-migration instruction.
   */
  reserved: ReadonlyArray<number>;
};

export function getClaimDecoder(): Decoder<Claim> {
  return getStructDecoder([
    ['discriminator', getU8Decoder()],
    ['pad', getArrayDecoder(getU8Decoder(), { size: 7 })],
    ['policy', fixDecoderSize(getAddressDecoder(), 32)],
    ['pool', fixDecoderSize(getAddressDecoder(), 32)],
    ['agent', fixDecoderSize(getAddressDecoder(), 32)],
    ['callId', getArrayDecoder(getU8Decoder(), { size: 32 })],
    ['evidenceHash', getArrayDecoder(getU8Decoder(), { size: 32 })],
    ['paymentAmount', getU64Decoder()],
    ['refundAmount', getU64Decoder()],
    ['callTimestamp', getI64Decoder()],
    ['createdAt', getI64Decoder()],
    ['resolvedAt', getI64Decoder()],
    ['latencyMs', getU32Decoder()],
    ['statusCode', getU16Decoder()],
    ['triggerType', getU8Decoder()],
    ['status', getU8Decoder()],
    ['bump', getU8Decoder()],
    ['padTail', getArrayDecoder(getU8Decoder(), { size: 7 })],
    ['reserved', getArrayDecoder(getU8Decoder(), { size: 64 })],
  ]);
}

export function decodeClaim(data: Uint8Array): Claim {
  return getClaimDecoder().decode(data);
}

/**
 * Derives the per-call claim PDA
 * (`seeds = [b"claim", policy, sha256(call_id)]`).
 *
 * The third seed is the **32-byte SHA-256 digest** of the raw `call_id`
 * UTF-8 bytes — NOT the raw string — to sidestep the 32-byte seed length
 * limit so agents can use call_ids up to `MAX_CALL_ID_LEN = 64`.
 */
export async function findClaimPda(
  policy: Address,
  callIdHash: ReadonlyUint8Array,
): Promise<ProgramDerivedAddress> {
  const addressEncoder = fixEncoderSize(getAddressEncoder(), 32);
  if (callIdHash.length !== 32) {
    throw new Error(
      `findClaimPda: callIdHash must be 32 bytes (sha256 digest), got ${callIdHash.length}`,
    );
  }
  return getProgramDerivedAddress({
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    seeds: [CLAIM_SEED, addressEncoder.encode(policy), callIdHash],
  });
}
