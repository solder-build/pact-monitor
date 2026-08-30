/**
 * Internal Borsh-style instruction-data writers.
 *
 * V2 handlers decode args with hand-rolled Borsh-compatible decoders
 * (`decode_opt_*` / `read_string` in the Rust crate). These writers produce
 * byte-for-byte matching output:
 *   - `Option<T>` → `[0x01, payload]` or `[0x00]`.
 *   - Borsh `String` → `[u32 LE length, utf-8 bytes]`.
 *   - Primitives → native little-endian.
 *   - `Address` (Solana pubkey) → 32 raw bytes (no tag).
 *
 * **Not re-exported** from `index.ts` — purely an internal helper.
 *
 * Implementation uses a `BufferWriter` that grows a `Buffer` on demand;
 * callers `finalize()` to get the exact-sized bytes for the
 * `TransactionInstruction.data` field.
 */
import { PublicKey } from "@solana/web3.js";

/**
 * Growing-buffer instruction-data builder. Initial capacity is generous (128
 * bytes) for the smaller instructions; `ensure` doubles on demand. The
 * `finalize` method returns the precise-length slice as a fresh Buffer.
 */
export class BufferWriter {
  private buf: Buffer;
  private offset = 0;

  constructor(initialCapacity = 128) {
    this.buf = Buffer.alloc(initialCapacity);
  }

  private ensure(n: number): void {
    while (this.offset + n > this.buf.length) {
      const bigger = Buffer.alloc(this.buf.length * 2);
      this.buf.copy(bigger);
      this.buf = bigger;
    }
  }

  writeU8(v: number): void {
    this.ensure(1);
    this.buf.writeUInt8(v & 0xff, this.offset);
    this.offset += 1;
  }

  writeU16LE(v: number): void {
    this.ensure(2);
    this.buf.writeUInt16LE(v & 0xffff, this.offset);
    this.offset += 2;
  }

  writeU32LE(v: number): void {
    this.ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.offset);
    this.offset += 4;
  }

  writeU64LE(v: bigint): void {
    this.ensure(8);
    this.buf.writeBigUInt64LE(v, this.offset);
    this.offset += 8;
  }

  writeI64LE(v: bigint): void {
    this.ensure(8);
    this.buf.writeBigInt64LE(v, this.offset);
    this.offset += 8;
  }

  writeAddress(p: PublicKey): void {
    this.ensure(32);
    Buffer.from(p.toBytes()).copy(this.buf, this.offset);
    this.offset += 32;
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    Buffer.from(bytes).copy(this.buf, this.offset);
    this.offset += bytes.length;
  }

  /** Borsh `String`: `[u32 LE length, utf-8 bytes]`. Caller is responsible for length caps. */
  writeBorshString(s: string): void {
    const bytes = new TextEncoder().encode(s);
    this.writeU32LE(bytes.length);
    this.writeBytes(bytes);
  }

  // ---- Option<T> encoders -------------------------------------------------
  writeOptionU8(v?: number): void {
    if (v === undefined) {
      this.writeU8(0);
    } else {
      this.writeU8(1);
      this.writeU8(v);
    }
  }
  writeOptionU16LE(v?: number): void {
    if (v === undefined) {
      this.writeU8(0);
    } else {
      this.writeU8(1);
      this.writeU16LE(v);
    }
  }
  writeOptionU64LE(v?: bigint): void {
    if (v === undefined) {
      this.writeU8(0);
    } else {
      this.writeU8(1);
      this.writeU64LE(v);
    }
  }
  writeOptionI64LE(v?: bigint): void {
    if (v === undefined) {
      this.writeU8(0);
    } else {
      this.writeU8(1);
      this.writeI64LE(v);
    }
  }
  writeOptionAddress(p?: PublicKey): void {
    if (p === undefined) {
      this.writeU8(0);
    } else {
      this.writeU8(1);
      this.writeAddress(p);
    }
  }
  /**
   * Borsh-compatible `Option<bool>` decoded as `Option<u8>` on chain
   * (`decode_opt_bool` accepts 0 or 1 only). Caller passes a boolean or
   * undefined; encoded as `[1, 0]`, `[1, 1]`, or `[0]`.
   */
  writeOptionBool(v?: boolean): void {
    if (v === undefined) {
      this.writeU8(0);
    } else {
      this.writeU8(1);
      this.writeU8(v ? 1 : 0);
    }
  }

  /**
   * Return a fresh Buffer with exactly the bytes written so far. Subsequent
   * writes to this writer are independent of the returned buffer.
   */
  finalize(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.offset));
  }
}
