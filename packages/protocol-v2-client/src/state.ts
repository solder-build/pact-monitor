/**
 * Account decoders for `@q3labs/pact-protocol-v2-client`.
 *
 * Mirrors `packages/program/programs-pinocchio/pact-network-v2-pinocchio/src/state.rs`
 * bit-for-bit. Each struct has a 1-byte discriminator + 7 bytes of padding,
 * with the first domain field at offset 8 (enforced on the Rust side by
 * compile-time `const _: () = assert!(offset_of!(…) == 8)`). Trailing
 * `reserved: [u8; 64]` is intentionally omitted from the decoded TS type —
 * callers should not see implementation pad.
 *
 * Field offsets are derived from the Rust struct ordering plus `repr(C)`
 * natural alignment with zero implicit padding (the structs are laid out
 * specifically so that `bytemuck::Pod` accepts them without filler).
 */
import {
  makeReader,
  readBytes32,
  readI64LE,
  readPubkey,
  readU16LE,
  readU32LE,
  readU64LE,
  readU8,
  readUtf8Slice,
} from "./decoders.js";

/** Canonical base58-encoded Solana pubkey shape. Matches V1's type alias. */
export type Pubkey = string;

// ---------------------------------------------------------------------------
// LEN constants — total serialized size of each account.
// ---------------------------------------------------------------------------
export const PROTOCOL_CONFIG_LEN = 256;
export const COVERAGE_POOL_LEN = 320;
export const UNDERWRITER_POSITION_LEN = 184;
export const POLICY_LEN = 320;
export const CLAIM_LEN = 288;

// ---------------------------------------------------------------------------
// Discriminator bytes (account types, NOT instructions — these are stored at
// offset 0 of every account data buffer).
// ---------------------------------------------------------------------------
export const ACCOUNT_DISC_PROTOCOL_CONFIG = 0;
export const ACCOUNT_DISC_COVERAGE_POOL = 1;
export const ACCOUNT_DISC_UNDERWRITER_POSITION = 2;
export const ACCOUNT_DISC_POLICY = 3;
export const ACCOUNT_DISC_CLAIM = 4;

// ---------------------------------------------------------------------------
// Enums — mirror Rust `#[repr(u8)]` enums.
// ---------------------------------------------------------------------------
export enum TriggerType {
  Timeout = 0,
  Error = 1,
  SchemaMismatch = 2,
  LatencySla = 3,
}

export enum ClaimStatus {
  Pending = 0,
  Approved = 1,
  Rejected = 2,
}

// ---------------------------------------------------------------------------
// ProtocolConfig — discriminator 0, 256 bytes.
// ---------------------------------------------------------------------------
export interface ProtocolConfig {
  authority: Pubkey;
  oracle: Pubkey;
  treasury: Pubkey;
  usdcMint: Pubkey;
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
}

export function decodeProtocolConfig(
  data: Buffer | Uint8Array
): ProtocolConfig {
  const v = makeReader(
    data,
    PROTOCOL_CONFIG_LEN,
    ACCOUNT_DISC_PROTOCOL_CONFIG,
    "ProtocolConfig"
  );
  return {
    authority: readPubkey(v, 8),
    oracle: readPubkey(v, 40),
    treasury: readPubkey(v, 72),
    usdcMint: readPubkey(v, 104),
    minPoolDeposit: readU64LE(v, 136),
    defaultMaxCoveragePerCall: readU64LE(v, 144),
    withdrawalCooldownSeconds: readI64LE(v, 152),
    aggregateCapWindowSeconds: readI64LE(v, 160),
    claimWindowSeconds: readI64LE(v, 168),
    protocolFeeBps: readU16LE(v, 176),
    defaultInsuranceRateBps: readU16LE(v, 178),
    minPremiumBps: readU16LE(v, 180),
    aggregateCapBps: readU16LE(v, 182),
    maxClaimsPerBatch: readU8(v, 184),
    paused: readU8(v, 185),
    bump: readU8(v, 186),
  };
}

// ---------------------------------------------------------------------------
// CoveragePool — discriminator 1, 320 bytes.
//
// `vaultBump` is the WP-8 cache stored in `_pad_tail[0]` (byte 250). Exposed
// even though no current builder consumes it because clients building
// signer-seeds for pool-PDA-signed CPIs need to know it without re-deriving.
// ---------------------------------------------------------------------------
export interface CoveragePool {
  authority: Pubkey;
  usdcMint: Pubkey;
  vault: Pubkey;
  providerHostname: string;
  providerHostnameLen: number;
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
  bump: number;
  vaultBump: number;
}

export function decodeCoveragePool(data: Buffer | Uint8Array): CoveragePool {
  const v = makeReader(
    data,
    COVERAGE_POOL_LEN,
    ACCOUNT_DISC_COVERAGE_POOL,
    "CoveragePool"
  );
  const providerHostnameLen = readU8(v, 248);
  return {
    authority: readPubkey(v, 8),
    usdcMint: readPubkey(v, 40),
    vault: readPubkey(v, 72),
    providerHostname: readUtf8Slice(v, 104, 64, providerHostnameLen),
    providerHostnameLen,
    totalDeposited: readU64LE(v, 168),
    totalAvailable: readU64LE(v, 176),
    totalPremiumsEarned: readU64LE(v, 184),
    totalClaimsPaid: readU64LE(v, 192),
    maxCoveragePerCall: readU64LE(v, 200),
    payoutsThisWindow: readU64LE(v, 208),
    windowStart: readI64LE(v, 216),
    createdAt: readI64LE(v, 224),
    updatedAt: readI64LE(v, 232),
    activePolicies: readU32LE(v, 240),
    insuranceRateBps: readU16LE(v, 244),
    minPremiumBps: readU16LE(v, 246),
    bump: readU8(v, 249),
    vaultBump: readU8(v, 250),
  };
}

// ---------------------------------------------------------------------------
// UnderwriterPosition — discriminator 2, 184 bytes.
// ---------------------------------------------------------------------------
export interface UnderwriterPosition {
  pool: Pubkey;
  underwriter: Pubkey;
  deposited: bigint;
  earnedPremiums: bigint;
  lossesAbsorbed: bigint;
  depositTimestamp: bigint;
  lastClaimTimestamp: bigint;
  bump: number;
}

export function decodeUnderwriterPosition(
  data: Buffer | Uint8Array
): UnderwriterPosition {
  const v = makeReader(
    data,
    UNDERWRITER_POSITION_LEN,
    ACCOUNT_DISC_UNDERWRITER_POSITION,
    "UnderwriterPosition"
  );
  return {
    pool: readPubkey(v, 8),
    underwriter: readPubkey(v, 40),
    deposited: readU64LE(v, 72),
    earnedPremiums: readU64LE(v, 80),
    lossesAbsorbed: readU64LE(v, 88),
    depositTimestamp: readI64LE(v, 96),
    lastClaimTimestamp: readI64LE(v, 104),
    bump: readU8(v, 112),
  };
}

// ---------------------------------------------------------------------------
// Policy — discriminator 3, 320 bytes.
//
// Phase 5 F1 tail (WP-12) at offsets 216/248/250. `referrer` is the raw
// 32-byte buffer (all-zero = None sentinel); callers should rely on
// `referrerPresent === 1` instead of comparing the bytes. `referrer` is
// exposed as `Pubkey` (base58) when present, `null` when absent — the more
// ergonomic shape for downstream code.
// ---------------------------------------------------------------------------
export interface Policy {
  agent: Pubkey;
  pool: Pubkey;
  agentTokenAccount: Pubkey;
  agentId: string;
  agentIdLen: number;
  totalPremiumsPaid: bigint;
  totalClaimsReceived: bigint;
  callsCovered: bigint;
  createdAt: bigint;
  expiresAt: bigint;
  active: number;
  bump: number;
  referrer: Pubkey | null;
  referrerShareBps: number;
  referrerPresent: number;
}

export function decodePolicy(data: Buffer | Uint8Array): Policy {
  const v = makeReader(data, POLICY_LEN, ACCOUNT_DISC_POLICY, "Policy");
  const agentIdLen = readU8(v, 208);
  const referrerPresent = readU8(v, 250);
  return {
    agent: readPubkey(v, 8),
    pool: readPubkey(v, 40),
    agentTokenAccount: readPubkey(v, 72),
    agentId: readUtf8Slice(v, 104, 64, agentIdLen),
    agentIdLen,
    totalPremiumsPaid: readU64LE(v, 168),
    totalClaimsReceived: readU64LE(v, 176),
    callsCovered: readU64LE(v, 184),
    createdAt: readI64LE(v, 192),
    expiresAt: readI64LE(v, 200),
    active: readU8(v, 209),
    bump: readU8(v, 210),
    referrer: referrerPresent === 1 ? readPubkey(v, 216) : null,
    referrerShareBps: readU16LE(v, 248),
    referrerPresent,
  };
}

// ---------------------------------------------------------------------------
// Claim — discriminator 4, 288 bytes.
//
// `callId` is the 32-byte SHA-256 digest the program stores in place of the
// raw string (WP-4 addendum #9). Reconcile against `hashCallId(rawCallId)`
// from `pda.ts` if you need to confirm a specific raw id maps to a claim.
// ---------------------------------------------------------------------------
export interface Claim {
  policy: Pubkey;
  pool: Pubkey;
  agent: Pubkey;
  callId: Uint8Array;
  evidenceHash: Uint8Array;
  paymentAmount: bigint;
  refundAmount: bigint;
  callTimestamp: bigint;
  createdAt: bigint;
  resolvedAt: bigint;
  latencyMs: number;
  statusCode: number;
  triggerType: TriggerType;
  status: ClaimStatus;
  bump: number;
}

export function decodeClaim(data: Buffer | Uint8Array): Claim {
  const v = makeReader(data, CLAIM_LEN, ACCOUNT_DISC_CLAIM, "Claim");
  const triggerByte = readU8(v, 214);
  const statusByte = readU8(v, 215);
  if (triggerByte < 0 || triggerByte > 3) {
    throw new Error(`Claim: invalid trigger_type byte ${triggerByte}`);
  }
  if (statusByte < 0 || statusByte > 2) {
    throw new Error(`Claim: invalid status byte ${statusByte}`);
  }
  return {
    policy: readPubkey(v, 8),
    pool: readPubkey(v, 40),
    agent: readPubkey(v, 72),
    callId: readBytes32(v, 104),
    evidenceHash: readBytes32(v, 136),
    paymentAmount: readU64LE(v, 168),
    refundAmount: readU64LE(v, 176),
    callTimestamp: readI64LE(v, 184),
    createdAt: readI64LE(v, 192),
    resolvedAt: readI64LE(v, 200),
    latencyMs: readU32LE(v, 208),
    statusCode: readU16LE(v, 212),
    triggerType: triggerByte as TriggerType,
    status: statusByte as ClaimStatus,
    bump: readU8(v, 216),
  };
}
