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
import {
  PACT_INSURANCE_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../programs/pactInsurance.js';
import {
  getInitializeProtocolArgsEncoder,
  type InitializeProtocolArgs,
} from '../types/initializeProtocolArgs.js';

export const INITIALIZE_PROTOCOL_DISCRIMINATOR = 0;

export type InitializeProtocolInstruction<
  TProgramAddress extends string = typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig extends string = string,
  TAccountDeployer extends string = string,
  TAccountSystemProgram extends string = typeof SYSTEM_PROGRAM_ADDRESS,
> = Instruction<TProgramAddress> &
  InstructionWithAccounts<
    readonly [
      AccountMeta<TAccountConfig>,
      AccountSignerMeta<TAccountDeployer>,
      AccountMeta<TAccountSystemProgram>,
    ]
  > &
  InstructionWithData<Uint8Array>;

export type InitializeProtocolInput<
  TAccountConfig extends string = string,
  TAccountDeployer extends string = string,
> = {
  /** Protocol config PDA — seeds = [b"protocol"]. Created by this instruction. */
  config: Address<TAccountConfig>;
  /** Fee payer that funds the PDA. Must sign. */
  deployer: TransactionSigner<TAccountDeployer>;
  args: InitializeProtocolArgs;
};

export function getInitializeProtocolInstruction<
  TAccountConfig extends string,
  TAccountDeployer extends string,
>(
  input: InitializeProtocolInput<TAccountConfig, TAccountDeployer>,
): InitializeProtocolInstruction<
  typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig,
  TAccountDeployer,
  typeof SYSTEM_PROGRAM_ADDRESS
> {
  const argsBytes = getInitializeProtocolArgsEncoder().encode(input.args);
  const data = new Uint8Array(1 + argsBytes.length);
  data[0] = INITIALIZE_PROTOCOL_DISCRIMINATOR;
  data.set(argsBytes, 1);

  const configMeta: AccountMeta<TAccountConfig> = {
    address: input.config,
    role: AccountRole.WRITABLE,
  };
  const deployerMeta: AccountSignerMeta<TAccountDeployer> = {
    address: input.deployer.address,
    role: AccountRole.WRITABLE_SIGNER,
    signer: input.deployer,
  };
  const systemMeta: AccountMeta<typeof SYSTEM_PROGRAM_ADDRESS> = {
    address: SYSTEM_PROGRAM_ADDRESS,
    role: AccountRole.READONLY,
  };

  return {
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    accounts: [configMeta, deployerMeta, systemMeta] as const,
    data,
  };
}
