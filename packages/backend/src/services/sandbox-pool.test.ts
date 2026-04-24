import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { SandboxKeypairPool } from "./sandbox-pool.js";

function makePool(n: number): SandboxKeypairPool {
  const kps = Array.from({ length: n }, () => Keypair.generate());
  return new SandboxKeypairPool(kps);
}

describe("SandboxKeypairPool", () => {
  it("throws on construction with zero keypairs", () => {
    assert.throws(() => new SandboxKeypairPool([]));
  });

  it("checks out keypairs in round-robin order", () => {
    const pool = makePool(3);
    const initialPubkeys = pool.pubkeys();
    const l1 = pool.checkout()!;
    const l2 = pool.checkout()!;
    const l3 = pool.checkout()!;
    assert.equal(l1.slot, 0);
    assert.equal(l2.slot, 1);
    assert.equal(l3.slot, 2);
    assert.equal(l1.keypair.publicKey.toBase58(), initialPubkeys[0]);
    assert.equal(l2.keypair.publicKey.toBase58(), initialPubkeys[1]);
    assert.equal(l3.keypair.publicKey.toBase58(), initialPubkeys[2]);
  });

  it("returns null when all keypairs are in use", () => {
    const pool = makePool(2);
    pool.checkout()!;
    pool.checkout()!;
    assert.equal(pool.checkout(), null);
  });

  it("release() makes a keypair available again", () => {
    const pool = makePool(1);
    const lease = pool.checkout()!;
    assert.equal(pool.checkout(), null);
    lease.release();
    const next = pool.checkout();
    assert.ok(next);
    assert.equal(
      next!.keypair.publicKey.toBase58(),
      lease.keypair.publicKey.toBase58(),
    );
  });

  it("release() is idempotent", () => {
    const pool = makePool(1);
    const lease = pool.checkout()!;
    lease.release();
    lease.release();
    assert.equal(pool.stats().inUse, 0);
  });

  it("rotates past released slots on next checkout", () => {
    const pool = makePool(3);
    const l0 = pool.checkout()!; // slot 0
    const l1 = pool.checkout()!; // slot 1
    l0.release();
    // Internal cursor is at slot 2 now; next checkout should hit slot 2, then
    // wrap to released slot 0 on the one after that.
    const l2 = pool.checkout()!;
    assert.equal(l2.slot, 2);
    const l3 = pool.checkout()!;
    assert.equal(l3.slot, 0);
    assert.equal(pool.checkout(), null);
    l1.release();
    l2.release();
    l3.release();
  });

  it("stats() reports available/in-use/total", () => {
    const pool = makePool(3);
    assert.deepEqual(pool.stats(), { total: 3, inUse: 0, available: 3 });
    const lease = pool.checkout()!;
    assert.deepEqual(pool.stats(), { total: 3, inUse: 1, available: 2 });
    lease.release();
    assert.deepEqual(pool.stats(), { total: 3, inUse: 0, available: 3 });
  });
});
