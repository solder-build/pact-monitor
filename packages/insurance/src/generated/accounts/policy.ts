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
  getU64Decoder,
  getU8Decoder,
  type Address,
  type Decoder,
  type ProgramDerivedAddress,
} from '@solana/kit';
import { PACT_INSURANCE_PROGRAM_ADDRESS } from '../programs/pactInsurance.js';

export const POLICY_SEED = new Uint8Array([
  // "policy"
  0x70, 0x6f, 0x6c, 0x69, 0x63, 0x79,
]);

export const POLICY_DISCRIMINATOR = 3;

/**
 * Layout mirror of the Rust `state::Policy` (bytemuck, repr(C)).
 *
 * Mirrors the WP-11.1 layout extension (Phase 5 F1 referrer fields + reserved
 * pad). Field order and sizes track the offset asserts pinned in
 * `src/state.rs` (`referrer` @ 216, `referrer_share_bps` @ 248,
 * `referrer_present` @ 250).
 */
export type Policy = {
  discriminator: number;
  pad: ReadonlyArray<number>;
  agent: Address;
  pool: Address;
  agentTokenAccount: Address;
  agentId: ReadonlyArray<number>;
  totalPremiumsPaid: bigint;
  totalClaimsReceived: bigint;
  callsCovered: bigint;
  createdAt: bigint;
  expiresAt: bigint;
  agentIdLen: number;
  active: number;
  bump: number;
  padTail: ReadonlyArray<number>;
  /** Phase 5 F1 — referrer wallet pubkey; all-zero bytes = None sentinel. */
  referrer: ReadonlyArray<number>;
  /** Phase 5 F1 — premium share in basis points (<= MAX_REFERRER_SHARE_BPS = 3000). */
  referrerShareBps: number;
  /** Phase 5 F1 — 1 = referrer slot populated, 0 = None. Paired with referrerShareBps. */
  referrerPresent: number;
  padReferrer: ReadonlyArray<number>;
  /**
   * WP-11.1 — 64-byte reserved pad. Project-wide convention (Rick Q3
   * 2026-04-24). Dedicated for future referrer-model extensions per PRD F1.
   */
  reserved: ReadonlyArray<number>;
};

export function getPolicyDecoder(): Decoder<Policy> {
  return getStructDecoder([
    ['discriminator', getU8Decoder()],
    ['pad', getArrayDecoder(getU8Decoder(), { size: 7 })],
    ['agent', fixDecoderSize(getAddressDecoder(), 32)],
    ['pool', fixDecoderSize(getAddressDecoder(), 32)],
    ['agentTokenAccount', fixDecoderSize(getAddressDecoder(), 32)],
    ['agentId', getArrayDecoder(getU8Decoder(), { size: 64 })],
    ['totalPremiumsPaid', getU64Decoder()],
    ['totalClaimsReceived', getU64Decoder()],
    ['callsCovered', getU64Decoder()],
    ['createdAt', getI64Decoder()],
    ['expiresAt', getI64Decoder()],
    ['agentIdLen', getU8Decoder()],
    ['active', getU8Decoder()],
    ['bump', getU8Decoder()],
    ['padTail', getArrayDecoder(getU8Decoder(), { size: 5 })],
    ['referrer', getArrayDecoder(getU8Decoder(), { size: 32 })],
    ['referrerShareBps', getU16Decoder()],
    ['referrerPresent', getU8Decoder()],
    ['padReferrer', getArrayDecoder(getU8Decoder(), { size: 5 })],
    ['reserved', getArrayDecoder(getU8Decoder(), { size: 64 })],
  ]);
}

export function decodePolicy(data: Uint8Array): Policy {
  return getPolicyDecoder().decode(data);
}

/**
 * Live slice of `agentId` up to `agentIdLen`, decoded as UTF-8.
 */
export function getPolicyAgentId(policy: Policy): string {
  const len = policy.agentIdLen;
  const bytes = new Uint8Array(policy.agentId.slice(0, len));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Derives the per-agent policy PDA (`seeds = [b"policy", pool, agent]`).
 * `agent` MUST be the agent's **wallet** pubkey — spec §3.6 note.
 */
export async function findPolicyPda(
  pool: Address,
  agent: Address,
): Promise<ProgramDerivedAddress> {
  const addressEncoder = fixEncoderSize(getAddressEncoder(), 32);
  return getProgramDerivedAddress({
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    seeds: [POLICY_SEED, addressEncoder.encode(pool), addressEncoder.encode(agent)],
  });
}
