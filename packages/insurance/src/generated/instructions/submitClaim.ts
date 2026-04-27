import {
  AccountRole,
  addEncoderSizePrefix,
  fixEncoderSize,
  getBytesEncoder,
  getI64Encoder,
  getStructEncoder,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  getU8Encoder,
  getUtf8Encoder,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Encoder,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from '@solana/kit';
import {
  PACT_INSURANCE_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../programs/pactInsurance.js';
import { SPL_TOKEN_PROGRAM_ADDRESS } from './createPool.js';

export const SUBMIT_CLAIM_DISCRIMINATOR = 10;

/**
 * TypeScript mirror of the Rust `TriggerType` enum (on-wire `u8`).
 * Keep ordering identical — the handler rejects unknown values with
 * `InvalidTriggerType` (6019).
 */
export enum TriggerType {
  Timeout = 0,
  Error = 1,
  SchemaMismatch = 2,
  LatencySla = 3,
}

/**
 * Args for `submit_claim` (disc 10).
 *
 * Wire format (bit-for-bit, little-endian where applicable):
 *   - `callId`: `String` — 4-byte u32 LE length + UTF-8 bytes. Handler
 *     rejects with `CallIdTooLong` (6017) when length > 64.
 *   - `triggerType`: `u8` — Borsh enum variant (0..=3).
 *   - `evidenceHash`: fixed `[u8; 32]`.
 *   - `callTimestamp`: `i64` LE.
 *   - `latencyMs`: `u32` LE.
 *   - `statusCode`: `u16` LE.
 *   - `paymentAmount`: `u64` LE. Handler rejects zero with `ZeroAmount` (6020).
 */
export type SubmitClaimArgs = {
  callId: string;
  triggerType: TriggerType;
  evidenceHash: ReadonlyUint8Array;
  callTimestamp: number | bigint;
  latencyMs: number;
  statusCode: number;
  paymentAmount: number | bigint;
};

export function getSubmitClaimArgsEncoder(): Encoder<SubmitClaimArgs> {
  return getStructEncoder([
    ['callId', addEncoderSizePrefix(getUtf8Encoder(), getU32Encoder())],
    ['triggerType', getU8Encoder()],
    ['evidenceHash', fixEncoderSize(getBytesEncoder(), 32)],
    ['callTimestamp', getI64Encoder()],
    ['latencyMs', getU32Encoder()],
    ['statusCode', getU16Encoder()],
    ['paymentAmount', getU64Encoder()],
  ]);
}

export type SubmitClaimInstruction<
  TProgramAddress extends string = typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountVault extends string = string,
  TAccountPolicy extends string = string,
  TAccountClaim extends string = string,
  TAccountAgentTokenAccount extends string = string,
  TAccountOracle extends string = string,
  TAccountTokenProgram extends string = typeof SPL_TOKEN_PROGRAM_ADDRESS,
  TAccountSystemProgram extends string = typeof SYSTEM_PROGRAM_ADDRESS,
> = Instruction<TProgramAddress> &
  InstructionWithAccounts<
    readonly [
      AccountMeta<TAccountConfig>,
      AccountMeta<TAccountPool>,
      AccountMeta<TAccountVault>,
      AccountMeta<TAccountPolicy>,
      AccountMeta<TAccountClaim>,
      AccountMeta<TAccountAgentTokenAccount>,
      AccountSignerMeta<TAccountOracle>,
      AccountMeta<TAccountTokenProgram>,
      AccountMeta<TAccountSystemProgram>,
    ]
  > &
  InstructionWithData<Uint8Array>;

export type SubmitClaimInput<
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountVault extends string = string,
  TAccountPolicy extends string = string,
  TAccountClaim extends string = string,
  TAccountAgentTokenAccount extends string = string,
  TAccountOracle extends string = string,
> = {
  /** Protocol config PDA — seeds = [b"protocol"]. Read-only. */
  config: Address<TAccountConfig>;
  /** Coverage pool PDA — seeds = [b"pool", providerHostname]. Signs Transfer CPI. */
  pool: Address<TAccountPool>;
  /** SPL-Token vault PDA — source of the refund transfer. */
  vault: Address<TAccountVault>;
  /** Policy PDA — seeds = [b"policy", pool, agent]. Must be active + unexpired. */
  policy: Address<TAccountPolicy>;
  /** Claim PDA — seeds = [b"claim", policy, sha256(callId)]. Created here. */
  claim: Address<TAccountClaim>;
  /** Agent ATA — refund payee; must equal `policy.agentTokenAccount`. */
  agentTokenAccount: Address<TAccountAgentTokenAccount>;
  /** Oracle signer; key must equal `config.oracle`. Pays claim PDA rent. */
  oracle: TransactionSigner<TAccountOracle>;
  args: SubmitClaimArgs;
};

export function getSubmitClaimInstruction<
  TAccountConfig extends string,
  TAccountPool extends string,
  TAccountVault extends string,
  TAccountPolicy extends string,
  TAccountClaim extends string,
  TAccountAgentTokenAccount extends string,
  TAccountOracle extends string,
>(
  input: SubmitClaimInput<
    TAccountConfig,
    TAccountPool,
    TAccountVault,
    TAccountPolicy,
    TAccountClaim,
    TAccountAgentTokenAccount,
    TAccountOracle
  >,
): SubmitClaimInstruction<
  typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig,
  TAccountPool,
  TAccountVault,
  TAccountPolicy,
  TAccountClaim,
  TAccountAgentTokenAccount,
  TAccountOracle,
  typeof SPL_TOKEN_PROGRAM_ADDRESS,
  typeof SYSTEM_PROGRAM_ADDRESS
> {
  const argsBytes = getSubmitClaimArgsEncoder().encode(input.args);
  const data = new Uint8Array(1 + argsBytes.length);
  data[0] = SUBMIT_CLAIM_DISCRIMINATOR;
  data.set(argsBytes, 1);

  const configMeta: AccountMeta<TAccountConfig> = {
    address: input.config,
    role: AccountRole.READONLY,
  };
  const poolMeta: AccountMeta<TAccountPool> = {
    address: input.pool,
    role: AccountRole.WRITABLE,
  };
  const vaultMeta: AccountMeta<TAccountVault> = {
    address: input.vault,
    role: AccountRole.WRITABLE,
  };
  const policyMeta: AccountMeta<TAccountPolicy> = {
    address: input.policy,
    role: AccountRole.WRITABLE,
  };
  const claimMeta: AccountMeta<TAccountClaim> = {
    address: input.claim,
    role: AccountRole.WRITABLE,
  };
  const agentAtaMeta: AccountMeta<TAccountAgentTokenAccount> = {
    address: input.agentTokenAccount,
    role: AccountRole.WRITABLE,
  };
  const oracleMeta: AccountSignerMeta<TAccountOracle> = {
    address: input.oracle.address,
    role: AccountRole.WRITABLE_SIGNER,
    signer: input.oracle,
  };
  const tokenMeta: AccountMeta<typeof SPL_TOKEN_PROGRAM_ADDRESS> = {
    address: SPL_TOKEN_PROGRAM_ADDRESS,
    role: AccountRole.READONLY,
  };
  const systemMeta: AccountMeta<typeof SYSTEM_PROGRAM_ADDRESS> = {
    address: SYSTEM_PROGRAM_ADDRESS,
    role: AccountRole.READONLY,
  };

  return {
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    accounts: [
      configMeta,
      poolMeta,
      vaultMeta,
      policyMeta,
      claimMeta,
      agentAtaMeta,
      oracleMeta,
      tokenMeta,
      systemMeta,
    ] as const,
    data,
  };
}
