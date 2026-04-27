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
import {
  PACT_INSURANCE_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../programs/pactInsurance.js';
import { SPL_TOKEN_PROGRAM_ADDRESS } from './createPool.js';

export const DEPOSIT_DISCRIMINATOR = 4;

export type DepositInstruction<
  TProgramAddress extends string = typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountVault extends string = string,
  TAccountPosition extends string = string,
  TAccountUnderwriterTokenAccount extends string = string,
  TAccountUnderwriter extends string = string,
  TAccountTokenProgram extends string = typeof SPL_TOKEN_PROGRAM_ADDRESS,
  TAccountSystemProgram extends string = typeof SYSTEM_PROGRAM_ADDRESS,
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
      AccountMeta<TAccountSystemProgram>,
    ]
  > &
  InstructionWithData<Uint8Array>;

export type DepositInput<
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountVault extends string = string,
  TAccountPosition extends string = string,
  TAccountUnderwriterTokenAccount extends string = string,
  TAccountUnderwriter extends string = string,
> = {
  /** Protocol config PDA — seeds = [b"protocol"]. Read-only. */
  config: Address<TAccountConfig>;
  /** Coverage pool PDA — seeds = [b"pool", providerHostname]. */
  pool: Address<TAccountPool>;
  /** SPL-Token vault PDA — seeds = [b"vault", pool]. Transfer destination. */
  vault: Address<TAccountVault>;
  /** Position PDA — seeds = [b"position", pool, underwriter]. init_if_needed. */
  position: Address<TAccountPosition>;
  /** Underwriter's SPL-Token account. mint must equal pool.usdcMint; owner must equal underwriter. */
  underwriterTokenAccount: Address<TAccountUnderwriterTokenAccount>;
  /** Fee payer + transfer authority. Signs the Transfer CPI and funds init. */
  underwriter: TransactionSigner<TAccountUnderwriter>;
  /** Deposit amount in USDC base units. */
  amount: bigint;
};

export function getDepositInstruction<
  TAccountConfig extends string,
  TAccountPool extends string,
  TAccountVault extends string,
  TAccountPosition extends string,
  TAccountUnderwriterTokenAccount extends string,
  TAccountUnderwriter extends string,
>(
  input: DepositInput<
    TAccountConfig,
    TAccountPool,
    TAccountVault,
    TAccountPosition,
    TAccountUnderwriterTokenAccount,
    TAccountUnderwriter
  >,
): DepositInstruction<
  typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig,
  TAccountPool,
  TAccountVault,
  TAccountPosition,
  TAccountUnderwriterTokenAccount,
  TAccountUnderwriter,
  typeof SPL_TOKEN_PROGRAM_ADDRESS,
  typeof SYSTEM_PROGRAM_ADDRESS
> {
  const amountBytes = getU64Encoder().encode(input.amount);
  const data = new Uint8Array(1 + 8);
  data[0] = DEPOSIT_DISCRIMINATOR;
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
    role: AccountRole.WRITABLE_SIGNER,
    signer: input.underwriter,
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
      positionMeta,
      underwriterTaMeta,
      underwriterMeta,
      tokenMeta,
      systemMeta,
    ] as const,
    data,
  };
}
