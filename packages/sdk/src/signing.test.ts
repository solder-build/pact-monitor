import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSignature, serializeRecords, verifySignature } from "./signing.js";
import { Keypair } from "@solana/web3.js";

describe("serializeRecords", () => {
  it("produces deterministic output regardless of key order", () => {
    const a = [{ z: 1, a: 2 }];
    const b = [{ a: 2, z: 1 }];
    assert.equal(serializeRecords(a), serializeRecords(b));
  });

  it("returns a string", () => {
    const result = serializeRecords([{ foo: "bar" }]);
    assert.equal(typeof result, "string");
  });
});

describe("createSignature + verifySignature", () => {
  it("round-trips with a valid keypair", () => {
    const keypair = Keypair.generate();
    const payload = JSON.stringify([{ hostname: "test.com", classification: "error" }]);

    const signature = createSignature(payload, keypair.secretKey);
    assert.equal(typeof signature, "string");

    const valid = verifySignature(payload, signature, keypair.publicKey.toBytes());
    assert.equal(valid, true);
  });

  it("rejects a tampered payload", () => {
    const keypair = Keypair.generate();
    const payload = JSON.stringify([{ hostname: "test.com" }]);
    const signature = createSignature(payload, keypair.secretKey);

    const tampered = JSON.stringify([{ hostname: "evil.com" }]);
    const valid = verifySignature(tampered, signature, keypair.publicKey.toBytes());
    assert.equal(valid, false);
  });

  it("rejects a wrong public key", () => {
    const keypair1 = Keypair.generate();
    const keypair2 = Keypair.generate();
    const payload = JSON.stringify([{ data: 1 }]);
    const signature = createSignature(payload, keypair1.secretKey);

    const valid = verifySignature(payload, signature, keypair2.publicKey.toBytes());
    assert.equal(valid, false);
  });
});
