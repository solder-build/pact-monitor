import {
  fixEncoderSize,
  getAddressEncoder,
  getStructEncoder,
  type Address,
  type Encoder,
} from '@solana/kit';

export type InitializeProtocolArgs = {
  authority: Address;
  oracle: Address;
  treasury: Address;
  usdcMint: Address;
};

export function getInitializeProtocolArgsEncoder(): Encoder<InitializeProtocolArgs> {
  return getStructEncoder([
    ['authority', fixEncoderSize(getAddressEncoder(), 32)],
    ['oracle', fixEncoderSize(getAddressEncoder(), 32)],
    ['treasury', fixEncoderSize(getAddressEncoder(), 32)],
    ['usdcMint', fixEncoderSize(getAddressEncoder(), 32)],
  ]);
}
