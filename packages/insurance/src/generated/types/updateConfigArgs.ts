import {
  fixEncoderSize,
  getAddressEncoder,
  getBooleanEncoder,
  getI64Encoder,
  getOptionEncoder,
  getStructEncoder,
  getU16Encoder,
  getU64Encoder,
  getU8Encoder,
  type Address,
  type Encoder,
  type OptionOrNullable,
} from '@solana/kit';

/**
 * Mirror of the Anchor `UpdateConfigArgs` Borsh type. Every field is an
 * `Option<T>` (1-byte tag, little-endian payload) — `None` leaves the stored
 * value untouched; `Some(v)` triggers a per-field safety-floor / freeze check
 * in the handler (see `instructions/update_config.rs`).
 *
 * Field order MUST match the handler's manual Borsh decoder. `treasury` and
 * `usdc_mint` are frozen: passing `Some(_)` for either returns
 * `PactError::FrozenConfigField` (custom error 6026).
 */
export type UpdateConfigArgs = {
  protocolFeeBps: OptionOrNullable<number>;
  minPoolDeposit: OptionOrNullable<number | bigint>;
  defaultInsuranceRateBps: OptionOrNullable<number>;
  defaultMaxCoveragePerCall: OptionOrNullable<number | bigint>;
  minPremiumBps: OptionOrNullable<number>;
  withdrawalCooldownSeconds: OptionOrNullable<number | bigint>;
  aggregateCapBps: OptionOrNullable<number>;
  aggregateCapWindowSeconds: OptionOrNullable<number | bigint>;
  claimWindowSeconds: OptionOrNullable<number | bigint>;
  maxClaimsPerBatch: OptionOrNullable<number>;
  paused: OptionOrNullable<boolean>;
  treasury: OptionOrNullable<Address>;
  usdcMint: OptionOrNullable<Address>;
};

export function getUpdateConfigArgsEncoder(): Encoder<UpdateConfigArgs> {
  return getStructEncoder([
    ['protocolFeeBps', getOptionEncoder(getU16Encoder())],
    ['minPoolDeposit', getOptionEncoder(getU64Encoder())],
    ['defaultInsuranceRateBps', getOptionEncoder(getU16Encoder())],
    ['defaultMaxCoveragePerCall', getOptionEncoder(getU64Encoder())],
    ['minPremiumBps', getOptionEncoder(getU16Encoder())],
    ['withdrawalCooldownSeconds', getOptionEncoder(getI64Encoder())],
    ['aggregateCapBps', getOptionEncoder(getU16Encoder())],
    ['aggregateCapWindowSeconds', getOptionEncoder(getI64Encoder())],
    ['claimWindowSeconds', getOptionEncoder(getI64Encoder())],
    ['maxClaimsPerBatch', getOptionEncoder(getU8Encoder())],
    ['paused', getOptionEncoder(getBooleanEncoder())],
    ['treasury', getOptionEncoder(fixEncoderSize(getAddressEncoder(), 32))],
    ['usdcMint', getOptionEncoder(fixEncoderSize(getAddressEncoder(), 32))],
  ]);
}
