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
  getEnableInsuranceArgsEncoder,
  type EnableInsuranceArgs,
} from '../types/enableInsuranceArgs.js';

export const ENABLE_INSURANCE_DISCRIMINATOR = 5;

export type EnableInsuranceInstruction<
  TProgramAddress extends string = typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountPolicy extends string = string,
  TAccountAgentTokenAccount extends string = string,
  TAccountAgent extends string = string,
  TAccountSystemProgram extends string = typeof SYSTEM_PROGRAM_ADDRESS,
> = Instruction<TProgramAddress> &
  InstructionWithAccounts<
    readonly [
      AccountMeta<TAccountConfig>,
      AccountMeta<TAccountPool>,
      AccountMeta<TAccountPolicy>,
      AccountMeta<TAccountAgentTokenAccount>,
      AccountSignerMeta<TAccountAgent>,
      AccountMeta<TAccountSystemProgram>,
    ]
  > &
  InstructionWithData<Uint8Array>;

export type EnableInsuranceInput<
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountPolicy extends string = string,
  TAccountAgentTokenAccount extends string = string,
  TAccountAgent extends string = string,
> = {
  /** Protocol config PDA — seeds = [b"protocol"]. Read-only. */
  config: Address<TAccountConfig>;
  /** Coverage pool PDA — seeds = [b"pool", providerHostname]. Writable (active_policies, updated_at). */
  pool: Address<TAccountPool>;
  /** Policy PDA — seeds = [b"policy", pool, agent (wallet)]. Created here. */
  policy: Address<TAccountPolicy>;
  /** Agent's SPL-Token account. mint == config.usdcMint; owner == agent; delegate == pool; delegated_amount > 0. */
  agentTokenAccount: Address<TAccountAgentTokenAccount>;
  /** Agent wallet. Tx signer; pays policy PDA rent. Seed for the policy PDA. */
  agent: TransactionSigner<TAccountAgent>;
  args: EnableInsuranceArgs;
};

export function getEnableInsuranceInstruction<
  TAccountConfig extends string,
  TAccountPool extends string,
  TAccountPolicy extends string,
  TAccountAgentTokenAccount extends string,
  TAccountAgent extends string,
>(
  input: EnableInsuranceInput<
    TAccountConfig,
    TAccountPool,
    TAccountPolicy,
    TAccountAgentTokenAccount,
    TAccountAgent
  >,
): EnableInsuranceInstruction<
  typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig,
  TAccountPool,
  TAccountPolicy,
  TAccountAgentTokenAccount,
  TAccountAgent,
  typeof SYSTEM_PROGRAM_ADDRESS
> {
  const argsBytes = getEnableInsuranceArgsEncoder().encode(input.args);
  const data = new Uint8Array(1 + argsBytes.length);
  data[0] = ENABLE_INSURANCE_DISCRIMINATOR;
  data.set(argsBytes, 1);

  const configMeta: AccountMeta<TAccountConfig> = {
    address: input.config,
    role: AccountRole.READONLY,
  };
  const poolMeta: AccountMeta<TAccountPool> = {
    address: input.pool,
    role: AccountRole.WRITABLE,
  };
  const policyMeta: AccountMeta<TAccountPolicy> = {
    address: input.policy,
    role: AccountRole.WRITABLE,
  };
  const agentTaMeta: AccountMeta<TAccountAgentTokenAccount> = {
    address: input.agentTokenAccount,
    role: AccountRole.READONLY,
  };
  const agentMeta: AccountSignerMeta<TAccountAgent> = {
    address: input.agent.address,
    role: AccountRole.WRITABLE_SIGNER,
    signer: input.agent,
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
      policyMeta,
      agentTaMeta,
      agentMeta,
      systemMeta,
    ] as const,
    data,
  };
}
