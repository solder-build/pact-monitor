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

export const UPDATE_RATES_DISCRIMINATOR = 9;

export type UpdateRatesInstruction<
  TProgramAddress extends string = typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountOracleSigner extends string = string,
> = Instruction<TProgramAddress> &
  InstructionWithAccounts<
    readonly [
      AccountMeta<TAccountConfig>,
      AccountMeta<TAccountPool>,
      AccountSignerMeta<TAccountOracleSigner>,
    ]
  > &
  InstructionWithData<Uint8Array>;

export type UpdateRatesInput<
  TAccountConfig extends string = string,
  TAccountPool extends string = string,
  TAccountOracleSigner extends string = string,
> = {
  /** Protocol config PDA — seeds = [b"protocol"]. Read-only source of `oracle`. */
  config: Address<TAccountConfig>;
  /** Coverage pool PDA — seeds = [b"pool", providerHostname]. Mutated in place. */
  pool: Address<TAccountPool>;
  /**
   * Must equal `config.oracle`, else the handler returns UnauthorizedOracle
   * (6025). Deliberately separate from the cold admin authority (C-02
   * continuation) — this is the rate-updater crank signer.
   */
  oracleSigner: TransactionSigner<TAccountOracleSigner>;
  /**
   * New insurance rate in basis points. Handler rejects values > 10_000 with
   * RateOutOfBounds (6027) and values < pool.minPremiumBps with RateBelowFloor
   * (6028). Anchor source uses a `u16` — mirrored here to keep the wire
   * layout bit-for-bit stable at WP-17 cut-over.
   */
  newRateBps: number;
};

export function getUpdateRatesInstruction<
  TAccountConfig extends string,
  TAccountPool extends string,
  TAccountOracleSigner extends string,
>(
  input: UpdateRatesInput<TAccountConfig, TAccountPool, TAccountOracleSigner>,
): UpdateRatesInstruction<
  typeof PACT_INSURANCE_PROGRAM_ADDRESS,
  TAccountConfig,
  TAccountPool,
  TAccountOracleSigner
> {
  // Payload: [disc (1 byte) | new_rate_bps (2 bytes LE)].
  // Matches the Anchor `update_rates(new_rate_bps: u16)` Borsh layout —
  // raw little-endian u16, no option tag, no length prefix.
  if (
    !Number.isInteger(input.newRateBps) ||
    input.newRateBps < 0 ||
    input.newRateBps > 0xffff
  ) {
    throw new RangeError(
      `updateRates: newRateBps must be an integer in [0, 65535], got ${input.newRateBps}`,
    );
  }
  const data = new Uint8Array(1 + 2);
  data[0] = UPDATE_RATES_DISCRIMINATOR;
  data[1] = input.newRateBps & 0xff;
  data[2] = (input.newRateBps >> 8) & 0xff;

  const configMeta: AccountMeta<TAccountConfig> = {
    address: input.config,
    role: AccountRole.READONLY,
  };
  const poolMeta: AccountMeta<TAccountPool> = {
    address: input.pool,
    role: AccountRole.WRITABLE,
  };
  const oracleMeta: AccountSignerMeta<TAccountOracleSigner> = {
    address: input.oracleSigner.address,
    role: AccountRole.READONLY_SIGNER,
    signer: input.oracleSigner,
  };

  return {
    programAddress: PACT_INSURANCE_PROGRAM_ADDRESS,
    accounts: [configMeta, poolMeta, oracleMeta] as const,
    data,
  };
}
