/**
 * Internal byte-read helpers used by `state.ts` decoders.
 *
 * Co-locating these here keeps the decoder bodies focused on field offsets
 * instead of raw `DataView` plumbing. Not re-exported by `index.ts` — purely
 * an implementation detail of this package.
 *
 * All reads are little-endian, matching the V2 program's bytemuck `repr(C)`
 * layout on a LE target (Solana is LE).
 */
import { PublicKey } from "@solana/web3.js";

/**
 * Wrap a raw account-data buffer in a typed reader. Validates length and the
 * leading discriminator byte; throws on mismatch. Callers then read fields by
 * offset.
 */
export function makeReader(
  data: Buffer | Uint8Array,
  expectedLen: number,
  expectedDisc: number,
  label: string
): DataView {
  if (data.length !== expectedLen) {
    throw new Error(
      `${label}: invalid length ${data.length} (expected ${expectedLen})`
    );
  }
  if (data[0] !== expectedDisc) {
    throw new Error(
      `${label}: invalid discriminator 0x${data[0].toString(16)} (expected 0x${expectedDisc.toString(16)})`
    );
  }
  // Wrap WITHOUT slicing — `DataView` can read directly from any ArrayBuffer.
  const buf = data instanceof Buffer ? data : Buffer.from(data);
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function readU8(view: DataView, offset: number): number {
  return view.getUint8(offset);
}

export function readU16LE(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

export function readU32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

export function readU64LE(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

export function readI64LE(view: DataView, offset: number): bigint {
  return view.getBigInt64(offset, true);
}

/**
 * Read a 32-byte Solana pubkey starting at `offset`. Returns the canonical
 * base58 string (matching V1 client's `Pubkey = string` decoded type).
 */
export function readPubkey(view: DataView, offset: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, 32);
  return new PublicKey(bytes).toBase58();
}

/**
 * Read a 32-byte raw byte field (e.g., Claim.call_id digest,
 * Claim.evidence_hash, Policy.referrer). Returns a fresh `Uint8Array` so the
 * caller cannot mutate the underlying buffer.
 */
export function readBytes32(view: DataView, offset: number): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset + offset, 32).slice();
}

/**
 * Slice a fixed-length UTF-8 buffer down to its companion length byte and
 * return a JS string. Used by CoveragePool (`provider_hostname` @ 104, len @
 * 248) and Policy (`agent_id` @ 104, len @ 208).
 */
export function readUtf8Slice(
  view: DataView,
  bufferOffset: number,
  maxLen: number,
  actualLen: number
): string {
  const clamped = Math.min(actualLen, maxLen);
  const bytes = new Uint8Array(
    view.buffer,
    view.byteOffset + bufferOffset,
    clamped
  );
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
