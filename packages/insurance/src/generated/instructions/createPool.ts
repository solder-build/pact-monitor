import {
  AccountRole,
  address,
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
import {
  getCreatePoolArgsEncoder,
  type CreatePoolArgs,
} from '../types/createPoolArgs.js';

export const CREATE_POOL_DISCRIMINATOR = 3;

export const SPL_TOKEN_PROGRAM_ADDRESS: Address = address(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

export const SYSVAR_RENT_ADDRESS: Address = address(
  'SysvarRent111111111111111111111111111111111',
);

export type CreatePoolInstruction<
  TProgramAddress extends string = typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountVault extends string = string,
  TAccountUsdcMint extends string = string,
  TAccountAuthority extends string = string,
  TAccountSystemProgram extends string = typeof SYSTEM_PROGRAM_ADDRESS,
  TAccountTokenProgram extends string = typeof SPL_TOKEN_PROGRAM_ADDRESS,
  TAccountRent extends string = typeof SYSVAR_RENT_ADDRESS,
> = Instruction<TProgramAddress> &
  InstructionWithAccounts<
    readonly [
      AccountMeta<TAccountConfig>,
      AccountMeta<TAccountPool>,
      AccountMeta<TAccountVault>,
      AccountMeta<TAccountUsdcMint>,
      AccountSignerMeta<TAccountAuthority>,
      AccountMeta<TAccountSystemProgram>,
      AccountMeta<TAccountTokenProgram>,
      AccountMeta<TAccountRent>,
    ]
  > &
  InstructionWithData<Uint8Array>;

export type CreatePoolInput<
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountVault extends string = string,
  TAccountUsdcMint extends string = string,
  TAccountAuthority extends string = string,
> = {
  /** Protocol config PDA — seeds = [b"protocol"]. Read-only. */
  config: Address<TAccountConfig>;
  /** Coverage pool PDA — seeds = [b"pool", providerHostnameBytes]. Created here. */
  pool: Address<TAccountPool>;
  /** Token-account vault PDA — seeds = [b"vault", poolPda]. Created here with `owner = spl_token::ID`. */
  vault: Address<TAccountVault>;
  /** USDC mint. Must equal `config.usdcMint` — handler rejects with Unauthorized (6018) otherwise. */
  poolUsdcMint: Address<TAccountUsdcMint>;
  /** Fee payer / protocol authority. Must match `config.authority`. */
  authority: TransactionSigner<TAccountAuthority>;
  args: CreatePoolArgs;
};

export function getCreatePoolInstruction<
  TAccountConfig extends string,
  TAccountPool extends string,
  TAccountVault extends string,
  TAccountUsdcMint extends string,
  TAccountAuthority extends string,
>(
  input: CreatePoolInput<
    TAccountConfig,
    TAccountPool,
    TAccountVault,
    TAccountUsdcMint,
    TAccountAuthority
  >,
): CreatePoolInstruction<
  typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig,
  TAccountPool,
  TAccountVault,
  TAccountUsdcMint,
  TAccountAuthority,
  typeof SYSTEM_PROGRAM_ADDRESS,
  typeof SPL_TOKEN_PROGRAM_ADDRESS,
  typeof SYSVAR_RENT_ADDRESS
> {
  const argsBytes = getCreatePoolArgsEncoder().encode(input.args);
  const data = new Uint8Array(1 + argsBytes.length);
  data[0] = CREATE_POOL_DISCRIMINATOR;
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
  const mintMeta: AccountMeta<TAccountUsdcMint> = {
    address: input.poolUsdcMint,
    role: AccountRole.READONLY,
  };
  const authorityMeta: AccountSignerMeta<TAccountAuthority> = {
    address: input.authority.address,
    role: AccountRole.WRITABLE_SIGNER,
    signer: input.authority,
  };
  const systemMeta: AccountMeta<typeof SYSTEM_PROGRAM_ADDRESS> = {
    address: SYSTEM_PROGRAM_ADDRESS,
    role: AccountRole.READONLY,
  };
  const tokenMeta: AccountMeta<typeof SPL_TOKEN_PROGRAM_ADDRESS> = {
    address: SPL_TOKEN_PROGRAM_ADDRESS,
    role: AccountRole.READONLY,
  };
  const rentMeta: AccountMeta<typeof SYSVAR_RENT_ADDRESS> = {
    address: SYSVAR_RENT_ADDRESS,
    role: AccountRole.READONLY,
  };

  return {
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    accounts: [
      configMeta,
      poolMeta,
      vaultMeta,
      mintMeta,
      authorityMeta,
      systemMeta,
      tokenMeta,
      rentMeta,
    ] as const,
    data,
  };
}
