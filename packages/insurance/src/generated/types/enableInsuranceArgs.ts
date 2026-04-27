import {
  addEncoderSizePrefix,
  fixEncoderSize,
  getBytesEncoder,
  getI64Encoder,
  getStructEncoder,
  getU16Encoder,
  getU32Encoder,
  getU8Encoder,
  getUtf8Encoder,
  type Encoder,
  type ReadonlyUint8Array,
} from '@solana/kit';

/**
 * Args for `enable_insurance` (disc 5) including the Phase 5 Feature 1
 * referrer snapshot.
 *
 * Wire format (bit-for-bit, little-endian where applicable):
 *   - `agentId`: `String` — 4-byte u32 LE length + UTF-8 bytes. Handler
 *     rejects with `AgentIdTooLong` (6016) if length > 64.
 *   - `expiresAt`: `i64` LE.
 *   - `referrer`: fixed `[u8; 32]`. All-zero bytes is the "None" sentinel,
 *     but `referrerPresent` is the explicit discriminant — see below.
 *   - `referrerPresent`: `u8` — 1 = Some, 0 = None. Must be mutually
 *     consistent with `referrerShareBps`.
 *   - `referrerShareBps`: `u16` LE — basis points of premium routed to the
 *     referrer on each `settle_premium`. `0` iff `referrerPresent == 0`.
 *     Handler rejects with `RateOutOfBounds` (6027) when > 3000, and with
 *     `InvalidRate` (6014) for mutual-exclusion violations.
 */
export type EnableInsuranceArgs = {
  agentId: string;
  expiresAt: number | bigint;
  referrer: ReadonlyUint8Array;
  referrerPresent: number;
  referrerShareBps: number;
};

export function getEnableInsuranceArgsEncoder(): Encoder<EnableInsuranceArgs> {
  return getStructEncoder([
    ['agentId', addEncoderSizePrefix(getUtf8Encoder(), getU32Encoder())],
    ['expiresAt', getI64Encoder()],
    ['referrer', fixEncoderSize(getBytesEncoder(), 32)],
    ['referrerPresent', getU8Encoder()],
    ['referrerShareBps', getU16Encoder()],
  ]);
}
