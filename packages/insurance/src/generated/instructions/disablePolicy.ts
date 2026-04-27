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

export const DISABLE_POLICY_DISCRIMINATOR = 6;

export type DisablePolicyInstruction<
  TProgramAddress extends string = typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountPool extends string = string,
  TAccountPolicy extends string = string,
  TAccountAgent extends string = string,
> = Instruction<TProgramAddress> &
  InstructionWithAccounts<
    readonly [
      AccountMeta<TAccountPool>,
      AccountMeta<TAccountPolicy>,
      AccountSignerMeta<TAccountAgent>,
    ]
  > &
  InstructionWithData<Uint8Array>;

export type DisablePolicyInput<
  TAccountPool extends string = string,
  TAccountPolicy extends string = string,
  TAccountAgent extends string = string,
> = {
  /** Coverage pool PDA — seeds = [b"pool", providerHostname]. Writable (active_policies saturating_sub 1). */
  pool: Address<TAccountPool>;
  /** Policy PDA — seeds = [b"policy", pool, agent]. Writable (active -> 0). */
  policy: Address<TAccountPolicy>;
  /** Agent wallet — must equal `policy.agent`. Read-only signer, no rent payment. */
  agent: TransactionSigner<TAccountAgent>;
};

export function getDisablePolicyInstruction<
  TAccountPool extends string,
  TAccountPolicy extends string,
  TAccountAgent extends string,
>(
  input: DisablePolicyInput<TAccountPool, TAccountPolicy, TAccountAgent>,
): DisablePolicyInstruction<
  typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountPool,
  TAccountPolicy,
  TAccountAgent
> {
  // Payload: [disc (1 byte)]. No args.
  const data = new Uint8Array([DISABLE_POLICY_DISCRIMINATOR]);

  const poolMeta: AccountMeta<TAccountPool> = {
    address: input.pool,
    role: AccountRole.WRITABLE,
  };
  const policyMeta: AccountMeta<TAccountPolicy> = {
    address: input.policy,
    role: AccountRole.WRITABLE,
  };
  const agentMeta: AccountSignerMeta<TAccountAgent> = {
    address: input.agent.address,
    role: AccountRole.READONLY_SIGNER,
    signer: input.agent,
  };

  return {
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    accounts: [poolMeta, policyMeta, agentMeta] as const,
    data,
  };
}
