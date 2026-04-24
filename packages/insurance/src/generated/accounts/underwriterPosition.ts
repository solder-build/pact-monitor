import {
  fixDecoderSize,
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getI64Decoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU64Decoder,
  getU8Decoder,
  type Address,
  type Decoder,
  type ProgramDerivedAddress,
} from '@solana/kit';
import { PACT_INSURANCE_PROGRAM_ADDRESS } from '../programs/pactInsurance.js';

export const UNDERWRITER_POSITION_SEED = new Uint8Array([
  // "position"
  0x70, 0x6f, 0x73, 0x69, 0x74, 0x69, 0x6f, 0x6e,
]);

export const UNDERWRITER_POSITION_DISCRIMINATOR = 2;

/**
 * Layout mirror of the Rust `state::UnderwriterPosition` (bytemuck, repr(C)).
 *
 * Fields are ordered so the first domain `publicKey` (`pool`) lands at byte
 * offset 8, matching the SDK's `memcmp(offset: 8)` invariant (spec §7.2).
 * `_pad_tail` is 7 bytes; unused by this account but preserved on-disk for
 * alignment and future forward-compatibility.
 */
export type UnderwriterPosition = {
  discriminator: number;
  pad: ReadonlyArray<number>;
  pool: Address;
  underwriter: Address;
  deposited: bigint;
  earnedPremiums: bigint;
  lossesAbsorbed: bigint;
  depositTimestamp: bigint;
  lastClaimTimestamp: bigint;
  bump: number;
  padTail: ReadonlyArray<number>;
  /**
   * WP-11.1 — 64-byte reserved pad. Project-wide convention (Rick Q3
   * 2026-04-24) so one future layout extension can land without a
   * state-migration instruction.
   */
  reserved: ReadonlyArray<number>;
};

export function getUnderwriterPositionDecoder(): Decoder<UnderwriterPosition> {
  return getStructDecoder([
    ['discriminator', getU8Decoder()],
    ['pad', getArrayDecoder(getU8Decoder(), { size: 7 })],
    ['pool', fixDecoderSize(getAddressDecoder(), 32)],
    ['underwriter', fixDecoderSize(getAddressDecoder(), 32)],
    ['deposited', getU64Decoder()],
    ['earnedPremiums', getU64Decoder()],
    ['lossesAbsorbed', getU64Decoder()],
    ['depositTimestamp', getI64Decoder()],
    ['lastClaimTimestamp', getI64Decoder()],
    ['bump', getU8Decoder()],
    ['padTail', getArrayDecoder(getU8Decoder(), { size: 7 })],
    ['reserved', getArrayDecoder(getU8Decoder(), { size: 64 })],
  ]);
}

export function decodeUnderwriterPosition(
  data: Uint8Array,
): UnderwriterPosition {
  return getUnderwriterPositionDecoder().decode(data);
}

/**
 * Derives the per-underwriter position PDA
 * (`seeds = [b"position", pool, underwriter]`).
 */
export async function findUnderwriterPositionPda(
  pool: Address,
  underwriter: Address,
): Promise<ProgramDerivedAddress> {
  const addressEncoder = fixEncoderSize(getAddressEncoder(), 32);
  return getProgramDerivedAddress({
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    seeds: [
      UNDERWRITER_POSITION_SEED,
      addressEncoder.encode(pool),
      addressEncoder.encode(underwriter),
    ],
  });
}
