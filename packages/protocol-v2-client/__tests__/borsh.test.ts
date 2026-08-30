import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { BufferWriter } from "../src/borsh.js";

function asHex(buf: Buffer): string {
  return buf.toString("hex");
}

describe("BufferWriter primitives", () => {
  it("writes u8 / u16 / u32 / u64 LE", () => {
    const w = new BufferWriter();
    w.writeU8(0xab);
    w.writeU16LE(0x1234);
    w.writeU32LE(0xdeadbeef);
    w.writeU64LE(0x0011223344556677n);
    // u8: ab; u16 LE: 3412; u32 LE: efbeadde; u64 LE: 7766554433221100
    expect(asHex(w.finalize())).toBe(
      "ab3412efbeadde7766554433221100"
    );
  });

  it("writes i64 LE (negative round-trip)", () => {
    const w = new BufferWriter();
    w.writeI64LE(-1n);
    expect(asHex(w.finalize())).toBe("ffffffffffffffff");
  });

  it("writes a 32-byte address", () => {
    const w = new BufferWriter();
    const pk = new PublicKey(new Uint8Array(32).fill(0xab));
    w.writeAddress(pk);
    expect(asHex(w.finalize())).toBe("ab".repeat(32));
  });
});

describe("BufferWriter.writeBorshString", () => {
  it("encodes as [u32 LE len, utf-8 bytes]", () => {
    const w = new BufferWriter();
    w.writeBorshString("abc");
    // len = 3 → 03 00 00 00; bytes: 61 62 63
    expect(asHex(w.finalize())).toBe("03000000616263");
  });

  it("encodes the empty string as just the length prefix", () => {
    const w = new BufferWriter();
    w.writeBorshString("");
    expect(asHex(w.finalize())).toBe("00000000");
  });

  it("handles multi-byte UTF-8 (length is byte count, not char count)", () => {
    const w = new BufferWriter();
    w.writeBorshString("é"); // U+00E9 → 0xc3 0xa9 (2 bytes)
    expect(asHex(w.finalize())).toBe("02000000c3a9");
  });
});

describe("BufferWriter Option encoders", () => {
  it("Option<u8> none = [0x00], some(7) = [0x01, 0x07]", () => {
    const w1 = new BufferWriter();
    w1.writeOptionU8();
    expect(asHex(w1.finalize())).toBe("00");
    const w2 = new BufferWriter();
    w2.writeOptionU8(7);
    expect(asHex(w2.finalize())).toBe("0107");
  });

  it("Option<u16> none vs some(0x1234)", () => {
    const w1 = new BufferWriter();
    w1.writeOptionU16LE();
    expect(asHex(w1.finalize())).toBe("00");
    const w2 = new BufferWriter();
    w2.writeOptionU16LE(0x1234);
    expect(asHex(w2.finalize())).toBe("013412");
  });

  it("Option<u64> none vs some", () => {
    const w1 = new BufferWriter();
    w1.writeOptionU64LE();
    expect(asHex(w1.finalize())).toBe("00");
    const w2 = new BufferWriter();
    w2.writeOptionU64LE(1n);
    expect(asHex(w2.finalize())).toBe("010100000000000000");
  });

  it("Option<i64> with negative payload", () => {
    const w = new BufferWriter();
    w.writeOptionI64LE(-1n);
    expect(asHex(w.finalize())).toBe("01ffffffffffffffff");
  });

  it("Option<Address> none vs some", () => {
    const w1 = new BufferWriter();
    w1.writeOptionAddress();
    expect(asHex(w1.finalize())).toBe("00");
    const w2 = new BufferWriter();
    const pk = new PublicKey(new Uint8Array(32).fill(0x11));
    w2.writeOptionAddress(pk);
    expect(asHex(w2.finalize())).toBe("01" + "11".repeat(32));
  });

  it("Option<bool> encodes true → [01,01], false → [01,00], undefined → [00]", () => {
    const wT = new BufferWriter();
    wT.writeOptionBool(true);
    expect(asHex(wT.finalize())).toBe("0101");
    const wF = new BufferWriter();
    wF.writeOptionBool(false);
    expect(asHex(wF.finalize())).toBe("0100");
    const wN = new BufferWriter();
    wN.writeOptionBool();
    expect(asHex(wN.finalize())).toBe("00");
  });
});

describe("BufferWriter capacity growth", () => {
  it("grows past the initial capacity without losing data", () => {
    const w = new BufferWriter(2);
    for (let i = 0; i < 64; i++) w.writeU8(i);
    const out = w.finalize();
    expect(out.length).toBe(64);
    for (let i = 0; i < 64; i++) expect(out[i]).toBe(i);
  });

  it("finalize returns an independent Buffer (subsequent writes do not mutate it)", () => {
    const w = new BufferWriter();
    w.writeU8(0xaa);
    const first = w.finalize();
    w.writeU8(0xbb);
    expect(asHex(first)).toBe("aa");
  });
});
