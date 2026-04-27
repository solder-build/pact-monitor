import {
  AccountRole,
  fixEncoderSize,
  getAddressEncoder,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type TransactionSigner,
} from '@solana/kit';
import { PACT_INSURANCE_PROGRAM_ADDRESS } from '../programs/pactInsurance.js';

export const UPDATE_ORACLE_DISCRIMINATOR = 2;

export type UpdateOracleInstruction<
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

export type UpdateOracleInput<
  TAccountConfig extends string = string,
  TAccountAuthority extends string = string,
> = {
  /** Protocol config PDA — seeds = [b"protocol"]. Mutated in place. */
  config: Address<TAccountConfig>;
  /** Must match `config.authority`. */
  authority: TransactionSigner<TAccountAuthority>;
  /**
   * Replacement oracle pubkey. Must be non-zero and not equal to
   * `config.authority`, else the handler returns `InvalidOracleKey` (6030).
   */
  newOracle: Address;
};

export function getUpdateOracleInstruction<
  TAccountConfig extends string,
  TAccountAuthority extends string,
>(
  input: UpdateOracleInput<TAccountConfig, TAccountAuthority>,
): UpdateOracleInstruction<
  typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig,
  TAccountAuthority
> {
  // Payload: [disc (1 byte) | new_oracle (32 bytes)].
  // Matches the Anchor `UpdateOracle { new_oracle: Pubkey }` Borsh layout —
  // no Option wrapper, no length prefix, plain 32 bytes.
  const oracleBytes = fixEncoderSize(getAddressEncoder(), 32).encode(
    input.newOracle,
  );
  const data = new Uint8Array(1 + oracleBytes.length);
  data[0] = UPDATE_ORACLE_DISCRIMINATOR;
  data.set(oracleBytes, 1);

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
