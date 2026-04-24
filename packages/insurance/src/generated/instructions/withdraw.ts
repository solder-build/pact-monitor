import {
  AccountRole,
  address,
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

export const WITHDRAW_DISCRIMINATOR = 8;

export const SYSVAR_CLOCK_ADDRESS: Address = address(
  'SysvarC1ock11111111111111111111111111111111',
);

export type WithdrawInstruction<
  TProgramAddress extends string = typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountVault extends string = string,
  TAccountPosition extends string = string,
  TAccountUnderwriterTokenAccount extends string = string,
  TAccountUnderwriter extends string = string,
  TAccountTokenProgram extends string = typeof SPL_TOKEN_PROGRAM_ADDRESS,
  TAccountClock extends string = typeof SYSVAR_CLOCK_ADDRESS,
> = Instruction<TProgramAddress> &
  InstructionWithAccounts<
    readonly [
      AccountMeta<TAccountConfig>,
      AccountMeta<TAccountPool>,
      AccountMeta<TAccountVault>,
      AccountMeta<TAccountPosition>,
      AccountMeta<TAccountUnderwriterTokenAccount>,
      AccountSignerMeta<TAccountUnderwriter>,
      AccountMeta<TAccountTokenProgram>,
      AccountMeta<TAccountClock>,
    ]
  > &
  InstructionWithData<Uint8Array>;

export type WithdrawInput<
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountVault extends string = string,
  TAccountPosition extends string = string,
  TAccountUnderwriterTokenAccount extends string = string,
  TAccountUnderwriter extends string = string,
> = {
  /** Protocol config PDA — seeds = [b"protocol"]. Read-only. */
  config: Address<TAccountConfig>;
  /** Coverage pool PDA — seeds = [b"pool", providerHostname]. Signs the Transfer CPI via pool_signer_seeds. */
  pool: Address<TAccountPool>;
  /** SPL-Token vault PDA — seeds = [b"vault", pool]. Source of the transfer. */
  vault: Address<TAccountVault>;
  /** Position PDA — seeds = [b"position", pool, underwriter]. Cooldown gate reads position.depositTimestamp. */
  position: Address<TAccountPosition>;
  /** Underwriter's SPL-Token account. mint must equal pool.usdcMint; owner must equal underwriter. */
  underwriterTokenAccount: Address<TAccountUnderwriterTokenAccount>;
  /** Underwriter wallet. Tx signer; the pool PDA (not the underwriter) signs the Transfer CPI. */
  underwriter: TransactionSigner<TAccountUnderwriter>;
  /** Withdrawal amount in USDC base units. */
  amount: bigint;
};

export function getWithdrawInstruction<
  TAccountConfig extends string,
  TAccountPool extends string,
  TAccountVault extends string,
  TAccountPosition extends string,
  TAccountUnderwriterTokenAccount extends string,
  TAccountUnderwriter extends string,
>(
  input: WithdrawInput<
    TAccountConfig,
    TAccountPool,
    TAccountVault,
    TAccountPosition,
    TAccountUnderwriterTokenAccount,
    TAccountUnderwriter
  >,
): WithdrawInstruction<
  typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig,
  TAccountPool,
  TAccountVault,
  TAccountPosition,
  TAccountUnderwriterTokenAccount,
  TAccountUnderwriter,
  typeof SPL_TOKEN_PROGRAM_ADDRESS,
  typeof SYSVAR_CLOCK_ADDRESS
> {
  const amountBytes = getU64Encoder().encode(input.amount);
  const data = new Uint8Array(1 + 8);
  data[0] = WITHDRAW_DISCRIMINATOR;
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
  const positionMeta: AccountMeta<TAccountPosition> = {
    address: input.position,
    role: AccountRole.WRITABLE,
  };
  const underwriterTaMeta: AccountMeta<TAccountUnderwriterTokenAccount> = {
    address: input.underwriterTokenAccount,
    role: AccountRole.WRITABLE,
  };
  const underwriterMeta: AccountSignerMeta<TAccountUnderwriter> = {
    address: input.underwriter.address,
    role: AccountRole.READONLY_SIGNER,
    signer: input.underwriter,
  };
  const tokenMeta: AccountMeta<typeof SPL_TOKEN_PROGRAM_ADDRESS> = {
    address: SPL_TOKEN_PROGRAM_ADDRESS,
    role: AccountRole.READONLY,
  };
  const clockMeta: AccountMeta<typeof SYSVAR_CLOCK_ADDRESS> = {
    address: SYSVAR_CLOCK_ADDRESS,
    role: AccountRole.READONLY,
  };

  return {
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    accounts: [
      configMeta,
      poolMeta,
      vaultMeta,
      positionMeta,
      underwriterTaMeta,
      underwriterMeta,
      tokenMeta,
      clockMeta,
    ] as const,
    data,
  };
}
