import {
  addEncoderSizePrefix,
  getOptionEncoder,
  getStructEncoder,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  getUtf8Encoder,
  type Encoder,
  type OptionOrNullable,
} from '@solana/kit';

/**
 * Mirror of the Anchor `CreatePoolArgs` Borsh type.
 *
 * Wire format (bit-for-bit equal to Anchor's auto-derived Borsh layout):
 *   - `providerHostname`: `String` — 4-byte `u32` LE length prefix + UTF-8 bytes.
 *     Handler rejects with `HostnameTooLong` (6015) if length > 64.
 *   - `insuranceRateBps`: `Option<u16>` — 1-byte tag + 2 bytes little-endian if Some.
 *     `null` means "use `config.default_insurance_rate_bps`".
 *   - `maxCoveragePerCall`: `Option<u64>` — 1-byte tag + 8 bytes little-endian if Some.
 *     `null` means "use `config.default_max_coverage_per_call`".
 */
export type CreatePoolArgs = {
  providerHostname: string;
  insuranceRateBps: OptionOrNullable<number>;
  maxCoveragePerCall: OptionOrNullable<number | bigint>;
};

export function getCreatePoolArgsEncoder(): Encoder<CreatePoolArgs> {
  return getStructEncoder([
    ['providerHostname', addEncoderSizePrefix(getUtf8Encoder(), getU32Encoder())],
    ['insuranceRateBps', getOptionEncoder(getU16Encoder())],
    ['maxCoveragePerCall', getOptionEncoder(getU64Encoder())],
  ]);
}
