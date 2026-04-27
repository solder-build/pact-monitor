import {
  AccountRole,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type TransactionSigner,
} from '@solana/kit';
import { PACT_INSURANCE_PROGRAM_ADDRESS } from '../programs/pactInsurance.js';
import {
  getUpdateConfigArgsEncoder,
  type UpdateConfigArgs,
} from '../types/updateConfigArgs.js';

export const UPDATE_CONFIG_DISCRIMINATOR = 1;

export type UpdateConfigInstruction<
  TProgramAddress extends string = typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig extends string = string,
  TAccountAuthority extends string = string,
> = Instruction<TProgramAddress> &
  InstructionWithAccounts<
    readonly [
      AccountMeta<TAccountConfig>,
      AccountSignerMeta<TAccountAuthority>,
    ]
  > &
  InstructionWithData<Uint8Array>;

export type UpdateConfigInput<
  TAccountConfig extends string = string,
  TAccountAuthority extends string = string,
> = {
  /** Protocol config PDA — seeds = [b"protocol"]. Mutated in place. */
  config: Address<TAccountConfig>;
  /** Must match `config.authority`. */
  authority: TransactionSigner<TAccountAuthority>;
  args: UpdateConfigArgs;
};

export function getUpdateConfigInstruction<
  TAccountConfig extends string,
  TAccountAuthority extends string,
>(
  input: UpdateConfigInput<TAccountConfig, TAccountAuthority>,
): UpdateConfigInstruction<
  typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig,
  TAccountAuthority
> {
  const argsBytes = getUpdateConfigArgsEncoder().encode(input.args);
  const data = new Uint8Array(1 + argsBytes.length);
  data[0] = UPDATE_CONFIG_DISCRIMINATOR;
  data.set(argsBytes, 1);

  const configMeta: AccountMeta<TAccountConfig> = {
    address: input.config,
    role: AccountRole.WRITABLE,
  };
  const authorityMeta: AccountSignerMeta<TAccountAuthority> = {
    address: input.authority.address,
    role: AccountRole.READONLY_SIGNER,
    signer: input.authority,
  };

  return {
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    accounts: [configMeta, authorityMeta] as const,
    data,
  };
}
