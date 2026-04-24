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
} from '@solana/kit';
import { PACT_INSURANCE_PROGRAM_ADDRESS } from '../programs/pactInsurance.js';

export const COVERAGE_POOL_SEED = new Uint8Array([
  // "pool"
  0x70, 0x6f, 0x6f, 0x6c,
]);

export const VAULT_SEED = new Uint8Array([
  // "vault"
  0x76, 0x61, 0x75, 0x6c, 0x74,
]);

export const COVERAGE_POOL_DISCRIMINATOR = 1;

/**
 * Layout mirror of the Rust `state::CoveragePool` (bytemuck, repr(C)).
 *
 * `providerHostname` is a fixed `[u8; 64]` buffer; the live slice is the
 * first `providerHostnameLen` bytes (WP-3 Alan-locked decision). The
 * trailing `_pad_tail` is 6 bytes on-disk — byte 0 is repurposed by WP-8's
 * handler to store the vault PDA bump so downstream handlers can skip
 * `find_program_address` on the hot path.
 */
export type CoveragePool = {
  discriminator: number;
  pad: ReadonlyArray<number>;
  authority: Address;
  usdcMint: Address;
  vault: Address;
  providerHostname: ReadonlyArray<number>;
  totalDeposited: bigint;
  totalAvailable: bigint;
  totalPremiumsEarned: bigint;
  totalClaimsPaid: bigint;
  maxCoveragePerCall: bigint;
  payoutsThisWindow: bigint;
  windowStart: bigint;
  createdAt: bigint;
  updatedAt: bigint;
  activePolicies: number;
  insuranceRateBps: number;
  minPremiumBps: number;
  providerHostnameLen: number;
  bump: number;
  padTail: ReadonlyArray<number>;
  /**
   * WP-11.1 — 64-byte reserved pad. Project-wide convention (Rick Q3
   * 2026-04-24). Distinct from `padTail`, whose byte 0 carries the vault PDA
   * bump (WP-8 addendum).
   */
  reserved: ReadonlyArray<number>;
};

export function getCoveragePoolDecoder(): Decoder<CoveragePool> {
  return getStructDecoder([
    ['discriminator', getU8Decoder()],
    ['pad', getArrayDecoder(getU8Decoder(), { size: 7 })],
    ['authority', fixDecoderSize(getAddressDecoder(), 32)],
    ['usdcMint', fixDecoderSize(getAddressDecoder(), 32)],
    ['vault', fixDecoderSize(getAddressDecoder(), 32)],
    ['providerHostname', getArrayDecoder(getU8Decoder(), { size: 64 })],
    ['totalDeposited', getU64Decoder()],
    ['totalAvailable', getU64Decoder()],
    ['totalPremiumsEarned', getU64Decoder()],
    ['totalClaimsPaid', getU64Decoder()],
    ['maxCoveragePerCall', getU64Decoder()],
    ['payoutsThisWindow', getU64Decoder()],
    ['windowStart', getI64Decoder()],
    ['createdAt', getI64Decoder()],
    ['updatedAt', getI64Decoder()],
    ['activePolicies', getU32Decoder()],
    ['insuranceRateBps', getU16Decoder()],
    ['minPremiumBps', getU16Decoder()],
    ['providerHostnameLen', getU8Decoder()],
    ['bump', getU8Decoder()],
    ['padTail', getArrayDecoder(getU8Decoder(), { size: 6 })],
    ['reserved', getArrayDecoder(getU8Decoder(), { size: 64 })],
  ]);
}

export function decodeCoveragePool(data: Uint8Array): CoveragePool {
  return getCoveragePoolDecoder().decode(data);
}

/**
 * Live slice of `providerHostname` up to `providerHostnameLen`, decoded as UTF-8.
 */
export function getCoveragePoolHostname(pool: CoveragePool): string {
  const len = pool.providerHostnameLen;
  const bytes = new Uint8Array(pool.providerHostname.slice(0, len));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Derives the per-provider coverage-pool PDA (`seeds = [b"pool", hostname]`).
 */
export async function findCoveragePoolPda(
  hostname: string,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    seeds: [COVERAGE_POOL_SEED, new TextEncoder().encode(hostname)],
  });
}

/**
 * Derives the per-pool USDC vault PDA (`seeds = [b"vault", poolPda]`).
 */
export async function findCoveragePoolVaultPda(
  poolPda: Address,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    seeds: [VAULT_SEED, fixEncoderSize(getAddressEncoder(), 32).encode(poolPda)],
  });
}
