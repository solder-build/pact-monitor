import {
  fixDecoderSize,
  getAddressDecoder,
  getArrayDecoder,
  getI64Decoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU16Decoder,
  getU64Decoder,
  getU8Decoder,
  type Address,
  type Decoder,
  type ProgramDerivedAddress,
} from '@solana/kit';
import { PACT_INSURANCE_PROGRAM_ADDRESS } from '../programs/pactInsurance.js';

export const PROTOCOL_CONFIG_SEED = new Uint8Array([
  // "protocol"
  0x70, 0x72, 0x6f, 0x74, 0x6f, 0x63, 0x6f, 0x6c,
]);

export const PROTOCOL_CONFIG_DISCRIMINATOR = 0;

/** Layout mirror of the Rust `state::ProtocolConfig` (bytemuck, repr(C)). */
export type ProtocolConfig = {
  discriminator: number;
  pad: ReadonlyArray<number>;
  authority: Address;
  oracle: Address;
  treasury: Address;
  usdcMint: Address;
  minPoolDeposit: bigint;
  defaultMaxCoveragePerCall: bigint;
  withdrawalCooldownSeconds: bigint;
  aggregateCapWindowSeconds: bigint;
  claimWindowSeconds: bigint;
  protocolFeeBps: number;
  defaultInsuranceRateBps: number;
  minPremiumBps: number;
  aggregateCapBps: number;
  maxClaimsPerBatch: number;
  paused: number;
  bump: number;
  padTail: ReadonlyArray<number>;
  /**
   * WP-11.1 — 64-byte reserved pad. Project-wide convention (Rick Q3
   * 2026-04-24) so one future layout extension can land without a
   * state-migration instruction.
   */
  reserved: ReadonlyArray<number>;
};

export function getProtocolConfigDecoder(): Decoder<ProtocolConfig> {
  return getStructDecoder([
    ['discriminator', getU8Decoder()],
    ['pad', getArrayDecoder(getU8Decoder(), { size: 7 })],
    ['authority', fixDecoderSize(getAddressDecoder(), 32)],
    ['oracle', fixDecoderSize(getAddressDecoder(), 32)],
    ['treasury', fixDecoderSize(getAddressDecoder(), 32)],
    ['usdcMint', fixDecoderSize(getAddressDecoder(), 32)],
    ['minPoolDeposit', getU64Decoder()],
    ['defaultMaxCoveragePerCall', getU64Decoder()],
    ['withdrawalCooldownSeconds', getI64Decoder()],
    ['aggregateCapWindowSeconds', getI64Decoder()],
    ['claimWindowSeconds', getI64Decoder()],
    ['protocolFeeBps', getU16Decoder()],
    ['defaultInsuranceRateBps', getU16Decoder()],
    ['minPremiumBps', getU16Decoder()],
    ['aggregateCapBps', getU16Decoder()],
    ['maxClaimsPerBatch', getU8Decoder()],
    ['paused', getU8Decoder()],
    ['bump', getU8Decoder()],
    ['padTail', getArrayDecoder(getU8Decoder(), { size: 5 })],
    ['reserved', getArrayDecoder(getU8Decoder(), { size: 64 })],
  ]);
}

export function decodeProtocolConfig(data: Uint8Array): ProtocolConfig {
  return getProtocolConfigDecoder().decode(data);
}

/**
 * Derives the singleton protocol-config PDA (`seeds = [b"protocol"]`) for the
 * default program address. Returns the 2-tuple `[Address, bump]`.
 */
export async function findProtocolConfigPda(): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    seeds: [PROTOCOL_CONFIG_SEED],
  });
}
