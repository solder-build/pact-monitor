import {
  AccountRole,
  getU64Encoder,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type TransactionSigner,
} from '@solana/kit';
import { PACT_INSURANCE_PROGRAM_ADDRESS } from '../programs/pactInsurance.js';
import { SPL_TOKEN_PROGRAM_ADDRESS } from './createPool.js';

export const SETTLE_PREMIUM_DISCRIMINATOR = 7;

export type SettlePremiumInstruction<
  TProgramAddress extends string = typeof PACT_INSURANCE_PROGRAM_ADDRESS,
> = Instruction<TProgramAddress> &
  InstructionWithAccounts<readonly AccountMeta[]> &
  InstructionWithData<Uint8Array>;

export type SettlePremiumInput<
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountVault extends string = string,
  TAccountPolicy extends string = string,
  TAccountTreasuryAta extends string = string,
  TAccountAgentAta extends string = string,
  TAccountOracleSigner extends string = string,
  TAccountReferrerAta extends string = string,
> = {
  /** Protocol config PDA — seeds = [b"protocol"]. Read-only. */
  config: Address<TAccountConfig>;
  /** Coverage pool PDA — seeds = [b"pool", providerHostname]. Signs Transfer CPIs. */
  pool: Address<TAccountPool>;
  /** SPL-Token vault PDA — seeds = [b"vault", pool]. Receives pool_cut. */
  vault: Address<TAccountVault>;
  /** Policy PDA — seeds = [b"policy", pool, agent]. H-05: `active` not required. */
  policy: Address<TAccountPolicy>;
  /** Treasury ATA; owner = config.treasury, mint = config.usdcMint. */
  treasuryAta: Address<TAccountTreasuryAta>;
  /** Agent ATA; delegate must be pool. Source of every transfer. */
  agentAta: Address<TAccountAgentAta>;
  /** Oracle signer; key must equal config.oracle. */
  oracleSigner: TransactionSigner<TAccountOracleSigner>;
  /** Call value in USDC base units (input to gross premium math). */
  callValue: bigint;
  /**
   * Phase 5 F1: referrer USDC ATA. Pass only when `policy.referrerPresent == 1`.
   * Appended to remaining_accounts at position 0. Owner must equal
   * `policy.referrer`; mint must equal `config.usdcMint`. Missing-or-mismatched
   * fails LOUD with `TokenAccountMismatch` (6005).
   */
  referrerTokenAccount?: Address<TAccountReferrerAta>;
};

export function getSettlePremiumInstruction<
  TAccountConfig extends string,
  TAccountPool extends string,
  TAccountVault extends string,
  TAccountPolicy extends string,
  TAccountTreasuryAta extends string,
  TAccountAgentAta extends string,
  TAccountOracleSigner extends string,
  TAccountReferrerAta extends string,
>(
  input: SettlePremiumInput<
    TAccountConfig,
    TAccountPool,
    TAccountVault,
    TAccountPolicy,
    TAccountTreasuryAta,
    TAccountAgentAta,
    TAccountOracleSigner,
    TAccountReferrerAta
  >,
): SettlePremiumInstruction {
  const amountBytes = getU64Encoder().encode(input.callValue);
  const data = new Uint8Array(1 + 8);
  data[0] = SETTLE_PREMIUM_DISCRIMINATOR;
  data.set(amountBytes, 1);

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
  const treasuryMeta: AccountMeta<TAccountTreasuryAta> = {
    address: input.treasuryAta,
    role: AccountRole.WRITABLE,
  };
  const agentMeta: AccountMeta<TAccountAgentAta> = {
    address: input.agentAta,
    role: AccountRole.WRITABLE,
  };
  const oracleMeta: AccountSignerMeta<TAccountOracleSigner> = {
    address: input.oracleSigner.address,
    role: AccountRole.READONLY_SIGNER,
    signer: input.oracleSigner,
  };
  const tokenMeta: AccountMeta<typeof SPL_TOKEN_PROGRAM_ADDRESS> = {
    address: SPL_TOKEN_PROGRAM_ADDRESS,
    role: AccountRole.READONLY,
  };

  const accounts: AccountMeta[] = [
    configMeta,
    poolMeta,
    vaultMeta,
    policyMeta,
    treasuryMeta,
    agentMeta,
    oracleMeta,
    tokenMeta,
  ];

  if (input.referrerTokenAccount !== undefined) {
    accounts.push({
      address: input.referrerTokenAccount,
      role: AccountRole.WRITABLE,
    } as AccountMeta<TAccountReferrerAta>);
  }

  return {
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    accounts,
    data,
  };
}
