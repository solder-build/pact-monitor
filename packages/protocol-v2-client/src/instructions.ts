/**
 * Instruction builders for the V2 program. Each builder returns a stock
 * `TransactionInstruction` from `@solana/web3.js` 1.x; callers compose them
 * into transactions (and may sign with wallet-adapter, Squads multisig, etc.)
 *
 * Builders take `PublicKey` (not `Keypair`) for every account — keeps the
 * write surface decoupled from the signer surface so multisig and offline
 * signing flows work without modification.
 *
 * Wire-format contracts are pinned by the per-instruction comments in
 * `src/instructions/*.rs` and exercised in `__tests__/instructions.test.ts`.
 */
import {
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { BufferWriter } from "./borsh.js";
import {
  ABSOLUTE_BPS_CAP,
  DISC_CREATE_POOL,
  DISC_DEPOSIT,
  DISC_DISABLE_POLICY,
  DISC_ENABLE_INSURANCE,
  DISC_INITIALIZE_PROTOCOL,
  DISC_SETTLE_PREMIUM,
  DISC_SUBMIT_CLAIM,
  DISC_UPDATE_CONFIG,
  DISC_UPDATE_ORACLE,
  DISC_UPDATE_RATES,
  DISC_WITHDRAW,
  MAX_AGENT_ID_LEN,
  MAX_CALL_ID_LEN,
  MAX_HOSTNAME_LEN,
  MAX_REFERRER_SHARE_BPS,
  TOKEN_PROGRAM_ID,
} from "./constants.js";
import { TriggerType } from "./state.js";

// Canonical zero-pubkey used to zero-fill the absent-referrer slot in
// `enable_insurance`. Stored as raw 32 zero bytes; the on-chain decoder
// pairs this with `referrer_present = 0` to mean "no referrer".
const ZERO_PUBKEY_BYTES = new Uint8Array(32);

// ---------------------------------------------------------------------------
// 0 — initialize_protocol
//
// Wire: raw 4 × 32-byte addresses (NOT Borsh — no length prefix, no option
// tag). Total payload = 128 bytes after the discriminator.
// Accounts: config (w, PDA), deployer (w, signer), system_program.
// ---------------------------------------------------------------------------
export interface InitializeProtocolParams {
  programId: PublicKey;
  configPda: PublicKey;
  deployer: PublicKey;
  authority: PublicKey;
  oracle: PublicKey;
  treasury: PublicKey;
  usdcMint: PublicKey;
}

export function buildInitializeProtocolIx(
  p: InitializeProtocolParams
): TransactionInstruction {
  const w = new BufferWriter(1 + 128);
  w.writeU8(DISC_INITIALIZE_PROTOCOL);
  w.writeAddress(p.authority);
  w.writeAddress(p.oracle);
  w.writeAddress(p.treasury);
  w.writeAddress(p.usdcMint);
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.configPda, isSigner: false, isWritable: true },
      { pubkey: p.deployer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: w.finalize(),
  });
}

// ---------------------------------------------------------------------------
// 1 — update_config
//
// Wire: 13 × Option<T>. Borsh-compatible (1-byte tag + payload-if-Some).
// Field order MUST match `UpdateConfigPatch::decode`:
//   protocol_fee_bps (u16), min_pool_deposit (u64),
//   default_insurance_rate_bps (u16), default_max_coverage_per_call (u64),
//   min_premium_bps (u16), withdrawal_cooldown_seconds (i64),
//   aggregate_cap_bps (u16), aggregate_cap_window_seconds (i64),
//   claim_window_seconds (i64), max_claims_per_batch (u8),
//   paused (bool→u8), treasury (Address — FROZEN), usdc_mint (Address — FROZEN).
//
// Per critique HIGH-4: `treasury` and `usdc_mint` are OMITTED from the
// public param type. The encoder always writes `0x00` (None) for both.
// Exposing them in TS would invite callers to set a frozen field and
// get a confusing on-chain reject.
//
// Accounts: config (w, PDA), authority (signer).
// ---------------------------------------------------------------------------
export interface UpdateConfigParams {
  programId: PublicKey;
  configPda: PublicKey;
  authority: PublicKey;
  protocolFeeBps?: number;
  minPoolDeposit?: bigint;
  defaultInsuranceRateBps?: number;
  defaultMaxCoveragePerCall?: bigint;
  minPremiumBps?: number;
  withdrawalCooldownSeconds?: bigint;
  aggregateCapBps?: number;
  aggregateCapWindowSeconds?: bigint;
  claimWindowSeconds?: bigint;
  maxClaimsPerBatch?: number;
  paused?: boolean;
}

export function buildUpdateConfigIx(
  p: UpdateConfigParams
): TransactionInstruction {
  const w = new BufferWriter();
  w.writeU8(DISC_UPDATE_CONFIG);
  w.writeOptionU16LE(p.protocolFeeBps);
  w.writeOptionU64LE(p.minPoolDeposit);
  w.writeOptionU16LE(p.defaultInsuranceRateBps);
  w.writeOptionU64LE(p.defaultMaxCoveragePerCall);
  w.writeOptionU16LE(p.minPremiumBps);
  w.writeOptionI64LE(p.withdrawalCooldownSeconds);
  w.writeOptionU16LE(p.aggregateCapBps);
  w.writeOptionI64LE(p.aggregateCapWindowSeconds);
  w.writeOptionI64LE(p.claimWindowSeconds);
  w.writeOptionU8(p.maxClaimsPerBatch);
  w.writeOptionBool(p.paused);
  // FROZEN fields — always None. NOT settable from TS (per critique HIGH-4).
  w.writeU8(0); // treasury Option<Address> = None
  w.writeU8(0); // usdc_mint Option<Address> = None
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.configPda, isSigner: false, isWritable: true },
      { pubkey: p.authority, isSigner: true, isWritable: false },
    ],
    data: w.finalize(),
  });
}

// ---------------------------------------------------------------------------
// 2 — update_oracle
//
// Wire: raw 32-byte address (no Option tag, no length prefix).
// Accounts: config (w, PDA), authority (signer).
// ---------------------------------------------------------------------------
export interface UpdateOracleParams {
  programId: PublicKey;
  configPda: PublicKey;
  authority: PublicKey;
  newOracle: PublicKey;
}

export function buildUpdateOracleIx(
  p: UpdateOracleParams
): TransactionInstruction {
  const w = new BufferWriter(1 + 32);
  w.writeU8(DISC_UPDATE_ORACLE);
  w.writeAddress(p.newOracle);
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.configPda, isSigner: false, isWritable: true },
      { pubkey: p.authority, isSigner: true, isWritable: false },
    ],
    data: w.finalize(),
  });
}

// ---------------------------------------------------------------------------
// 3 — create_pool
//
// Wire (after disc):
//   Borsh String hostname (u32 LE len + utf-8 bytes; len ≤ 64)
//   Option<u16> insurance_rate_bps
//   Option<u64> max_coverage_per_call
// Accounts: config (r, PDA), pool (w, PDA), vault (w, PDA), poolUsdcMint (r),
//   authority (w, signer), system_program, token_program, rent sysvar.
// ---------------------------------------------------------------------------
export interface CreatePoolParams {
  programId: PublicKey;
  configPda: PublicKey;
  poolPda: PublicKey;
  vaultPda: PublicKey;
  poolUsdcMint: PublicKey;
  authority: PublicKey;
  hostname: string;
  insuranceRateBps?: number;
  maxCoveragePerCall?: bigint;
}

export function buildCreatePoolIx(p: CreatePoolParams): TransactionInstruction {
  const bytes = new TextEncoder().encode(p.hostname);
  if (bytes.length > MAX_HOSTNAME_LEN) {
    throw new Error(
      `hostname too long: ${bytes.length} bytes (max ${MAX_HOSTNAME_LEN})`
    );
  }
  if (p.insuranceRateBps !== undefined && p.insuranceRateBps > ABSOLUTE_BPS_CAP) {
    throw new Error(
      `insuranceRateBps ${p.insuranceRateBps} exceeds 10000 cap`
    );
  }
  const w = new BufferWriter();
  w.writeU8(DISC_CREATE_POOL);
  w.writeBorshString(p.hostname);
  w.writeOptionU16LE(p.insuranceRateBps);
  w.writeOptionU64LE(p.maxCoveragePerCall);
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.configPda, isSigner: false, isWritable: false },
      { pubkey: p.poolPda, isSigner: false, isWritable: true },
      { pubkey: p.vaultPda, isSigner: false, isWritable: true },
      { pubkey: p.poolUsdcMint, isSigner: false, isWritable: false },
      { pubkey: p.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: w.finalize(),
  });
}

// ---------------------------------------------------------------------------
// 4 — deposit
//
// Wire: u64 LE amount (8 bytes).
// Accounts: config (r), pool (w), vault (w, SPL), position (w, PDA),
//   underwriterTa (w, SPL), underwriter (w, signer), token_program, system_program.
// ---------------------------------------------------------------------------
export interface DepositParams {
  programId: PublicKey;
  configPda: PublicKey;
  poolPda: PublicKey;
  vault: PublicKey;
  positionPda: PublicKey;
  underwriterTokenAccount: PublicKey;
  underwriter: PublicKey;
  amount: bigint;
}

export function buildDepositIx(p: DepositParams): TransactionInstruction {
  if (p.amount <= 0n) throw new Error("deposit amount must be > 0");
  const w = new BufferWriter(1 + 8);
  w.writeU8(DISC_DEPOSIT);
  w.writeU64LE(p.amount);
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.configPda, isSigner: false, isWritable: false },
      { pubkey: p.poolPda, isSigner: false, isWritable: true },
      { pubkey: p.vault, isSigner: false, isWritable: true },
      { pubkey: p.positionPda, isSigner: false, isWritable: true },
      { pubkey: p.underwriterTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.underwriter, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: w.finalize(),
  });
}

// ---------------------------------------------------------------------------
// 5 — enable_insurance
//
// **CRITICAL ENCODING (per critique CRIT-1, confidence 100):** the on-chain
// decoder ALWAYS reads the 35-byte referrer tail:
//   referrer [u8; 32], referrer_present [u8], referrer_share_bps [u16 LE]
// The Option-style tag is NOT used here — the trailer is fixed-width on
// every payload. The builder API exposes the trailer as an ergonomic
// optional (`referrer?: { destination, shareBps }`), but the ENCODER
// ALWAYS writes 35 bytes. Absent → 32 zero bytes + 0x00 + 2 zero bytes.
// Forgetting this would silently fail every no-referrer enable_insurance
// call (the common case).
//
// Wire (after disc):
//   Borsh String agent_id (u32 LE len + utf-8 bytes; len ≤ 64)
//   i64 LE expires_at
//   [u8; 32] referrer        — zero-filled if absent
//   u8 referrer_present      — 0 or 1
//   u16 LE referrer_share_bps — 0 if absent
//
// Accounts: config (r), pool (w), policy (w, PDA), agentTa (r), agent (w, signer), system_program.
// ---------------------------------------------------------------------------
export interface EnableInsuranceParams {
  programId: PublicKey;
  configPda: PublicKey;
  poolPda: PublicKey;
  policyPda: PublicKey;
  agentTokenAccount: PublicKey;
  agent: PublicKey;
  agentId: string;
  expiresAt: bigint;
  referrer?: { destination: PublicKey; shareBps: number };
}

export function buildEnableInsuranceIx(
  p: EnableInsuranceParams
): TransactionInstruction {
  const idBytes = new TextEncoder().encode(p.agentId);
  if (idBytes.length > MAX_AGENT_ID_LEN) {
    throw new Error(
      `agentId too long: ${idBytes.length} bytes (max ${MAX_AGENT_ID_LEN})`
    );
  }
  if (p.referrer) {
    if (
      p.referrer.shareBps <= 0 ||
      p.referrer.shareBps > MAX_REFERRER_SHARE_BPS
    ) {
      throw new Error(
        `referrer.shareBps ${p.referrer.shareBps} out of range (1..=${MAX_REFERRER_SHARE_BPS})`
      );
    }
  }
  const w = new BufferWriter();
  w.writeU8(DISC_ENABLE_INSURANCE);
  w.writeBorshString(p.agentId);
  w.writeI64LE(p.expiresAt);
  // Fixed 35-byte referrer tail — see CRIT-1 above.
  if (p.referrer) {
    w.writeAddress(p.referrer.destination);
    w.writeU8(1);
    w.writeU16LE(p.referrer.shareBps);
  } else {
    w.writeBytes(ZERO_PUBKEY_BYTES);
    w.writeU8(0);
    w.writeU16LE(0);
  }
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.configPda, isSigner: false, isWritable: false },
      { pubkey: p.poolPda, isSigner: false, isWritable: true },
      { pubkey: p.policyPda, isSigner: false, isWritable: true },
      { pubkey: p.agentTokenAccount, isSigner: false, isWritable: false },
      { pubkey: p.agent, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: w.finalize(),
  });
}

// ---------------------------------------------------------------------------
// 6 — disable_policy
//
// Wire: empty (data must be exactly 1 byte: just the discriminator).
// Accounts: pool (w, PDA), policy (w, PDA), agent (signer).
// ---------------------------------------------------------------------------
export interface DisablePolicyParams {
  programId: PublicKey;
  poolPda: PublicKey;
  policyPda: PublicKey;
  agent: PublicKey;
}

export function buildDisablePolicyIx(
  p: DisablePolicyParams
): TransactionInstruction {
  const w = new BufferWriter(1);
  w.writeU8(DISC_DISABLE_POLICY);
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.poolPda, isSigner: false, isWritable: true },
      { pubkey: p.policyPda, isSigner: false, isWritable: true },
      { pubkey: p.agent, isSigner: true, isWritable: false },
    ],
    data: w.finalize(),
  });
}

// ---------------------------------------------------------------------------
// 7 — settle_premium
//
// Wire: u64 LE call_value (8 bytes).
//
// Account list:
//   0..7: config (r), pool (w), vault (w), policy (w), treasuryAta (w),
//         agentAta (w), oracleSigner (signer), token_program.
//   [8]:  referrerTa (w, SPL) — APPENDED as remaining_accounts[0] when caller
//         supplies it. The on-chain handler reads accounts[8] only when
//         `policy.referrer_present == 1`. Mismatch with the policy snapshot
//         fails LOUD with 6005 TokenAccountMismatch — caller must read the
//         policy first to decide whether to pass referrerTa.
// ---------------------------------------------------------------------------
export interface SettlePremiumParams {
  programId: PublicKey;
  configPda: PublicKey;
  poolPda: PublicKey;
  vault: PublicKey;
  policyPda: PublicKey;
  treasuryAta: PublicKey;
  agentAta: PublicKey;
  oracleSigner: PublicKey;
  callValue: bigint;
  /** Pass only if `policy.referrer_present == 1`. See note above. */
  referrerTokenAccount?: PublicKey;
}

export function buildSettlePremiumIx(
  p: SettlePremiumParams
): TransactionInstruction {
  if (p.callValue <= 0n) throw new Error("callValue must be > 0");
  const w = new BufferWriter(1 + 8);
  w.writeU8(DISC_SETTLE_PREMIUM);
  w.writeU64LE(p.callValue);
  const keys = [
    { pubkey: p.configPda, isSigner: false, isWritable: false },
    { pubkey: p.poolPda, isSigner: false, isWritable: true },
    { pubkey: p.vault, isSigner: false, isWritable: true },
    { pubkey: p.policyPda, isSigner: false, isWritable: true },
    { pubkey: p.treasuryAta, isSigner: false, isWritable: true },
    { pubkey: p.agentAta, isSigner: false, isWritable: true },
    { pubkey: p.oracleSigner, isSigner: true, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  if (p.referrerTokenAccount) {
    keys.push({
      pubkey: p.referrerTokenAccount,
      isSigner: false,
      isWritable: true,
    });
  }
  return new TransactionInstruction({
    programId: p.programId,
    keys,
    data: w.finalize(),
  });
}

// ---------------------------------------------------------------------------
// 8 — withdraw
//
// Wire: u64 LE amount (8 bytes). Pool-PDA-signed Transfer happens inside the
// handler — the underwriter signs the TX (fees), the pool PDA signs the Transfer.
// Accounts: config (r), pool (w), vault (w, SPL), position (w, PDA),
//   underwriterTa (w, SPL), underwriter (signer), token_program, clock sysvar.
// ---------------------------------------------------------------------------
export interface WithdrawParams {
  programId: PublicKey;
  configPda: PublicKey;
  poolPda: PublicKey;
  vault: PublicKey;
  positionPda: PublicKey;
  underwriterTokenAccount: PublicKey;
  underwriter: PublicKey;
  amount: bigint;
}

export function buildWithdrawIx(p: WithdrawParams): TransactionInstruction {
  if (p.amount <= 0n) throw new Error("withdraw amount must be > 0");
  const w = new BufferWriter(1 + 8);
  w.writeU8(DISC_WITHDRAW);
  w.writeU64LE(p.amount);
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.configPda, isSigner: false, isWritable: false },
      { pubkey: p.poolPda, isSigner: false, isWritable: true },
      { pubkey: p.vault, isSigner: false, isWritable: true },
      { pubkey: p.positionPda, isSigner: false, isWritable: true },
      { pubkey: p.underwriterTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p.underwriter, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: w.finalize(),
  });
}

// ---------------------------------------------------------------------------
// 9 — update_rates
//
// Wire: u16 LE new_rate_bps (2 bytes).
// Accounts: config (r), pool (w), oracleSigner (signer).
// ---------------------------------------------------------------------------
export interface UpdateRatesParams {
  programId: PublicKey;
  configPda: PublicKey;
  poolPda: PublicKey;
  oracleSigner: PublicKey;
  newRateBps: number;
}

export function buildUpdateRatesIx(
  p: UpdateRatesParams
): TransactionInstruction {
  if (p.newRateBps < 0 || p.newRateBps > ABSOLUTE_BPS_CAP) {
    throw new Error(
      `newRateBps ${p.newRateBps} out of range (0..=${ABSOLUTE_BPS_CAP})`
    );
  }
  const w = new BufferWriter(1 + 2);
  w.writeU8(DISC_UPDATE_RATES);
  w.writeU16LE(p.newRateBps);
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.configPda, isSigner: false, isWritable: false },
      { pubkey: p.poolPda, isSigner: false, isWritable: true },
      { pubkey: p.oracleSigner, isSigner: true, isWritable: false },
    ],
    data: w.finalize(),
  });
}

// ---------------------------------------------------------------------------
// 10 — submit_claim
//
// Wire (after disc):
//   Borsh String call_id (u32 LE len + utf-8 bytes; len ≤ 64)
//   u8 trigger_type (0..=3)
//   [u8; 32] evidence_hash
//   i64 LE call_timestamp
//   u32 LE latency_ms
//   u16 LE status_code
//   u64 LE payment_amount
//
// Accounts: config (r), pool (w), vault (w, SPL), policy (w, PDA),
//   claim (w, PDA — caller derives via getClaimPda),
//   agentAta (w, SPL), oracle (w, signer), token_program, system_program.
// ---------------------------------------------------------------------------
export interface SubmitClaimParams {
  programId: PublicKey;
  configPda: PublicKey;
  poolPda: PublicKey;
  vault: PublicKey;
  policyPda: PublicKey;
  claimPda: PublicKey;
  agentAta: PublicKey;
  oracle: PublicKey;
  callId: string;
  triggerType: TriggerType;
  evidenceHash: Uint8Array;
  callTimestamp: bigint;
  latencyMs: number;
  statusCode: number;
  paymentAmount: bigint;
}

export function buildSubmitClaimIx(
  p: SubmitClaimParams
): TransactionInstruction {
  const callIdBytes = new TextEncoder().encode(p.callId);
  if (callIdBytes.length > MAX_CALL_ID_LEN) {
    throw new Error(
      `callId too long: ${callIdBytes.length} bytes (max ${MAX_CALL_ID_LEN})`
    );
  }
  if (p.evidenceHash.length !== 32) {
    throw new Error(
      `evidenceHash must be exactly 32 bytes (got ${p.evidenceHash.length})`
    );
  }
  if (p.triggerType < 0 || p.triggerType > 3) {
    throw new Error(`triggerType ${p.triggerType} out of range (0..=3)`);
  }
  if (p.paymentAmount <= 0n) throw new Error("paymentAmount must be > 0");

  const w = new BufferWriter();
  w.writeU8(DISC_SUBMIT_CLAIM);
  w.writeBorshString(p.callId);
  w.writeU8(p.triggerType);
  w.writeBytes(p.evidenceHash);
  w.writeI64LE(p.callTimestamp);
  w.writeU32LE(p.latencyMs);
  w.writeU16LE(p.statusCode);
  w.writeU64LE(p.paymentAmount);
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.configPda, isSigner: false, isWritable: false },
      { pubkey: p.poolPda, isSigner: false, isWritable: true },
      { pubkey: p.vault, isSigner: false, isWritable: true },
      { pubkey: p.policyPda, isSigner: false, isWritable: true },
      { pubkey: p.claimPda, isSigner: false, isWritable: true },
      { pubkey: p.agentAta, isSigner: false, isWritable: true },
      { pubkey: p.oracle, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: w.finalize(),
  });
}
