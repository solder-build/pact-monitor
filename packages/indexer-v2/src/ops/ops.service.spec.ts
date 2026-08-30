// Ops handlers: round-trip via v2-client decoders to confirm the ix bytes
// the operator gets back are parseable by the SAME builders that produced
// them.

import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  DISC_CREATE_POOL,
  DISC_UPDATE_CONFIG,
  DISC_UPDATE_ORACLE,
  DISC_UPDATE_RATES,
  PROGRAM_ID,
  USDC_MINT_DEVNET,
  getCoveragePoolPda,
  getProtocolConfigPda,
} from "@q3labs/pact-protocol-v2-client";
import { OpsService } from "./ops.service";

function fakeConfig(): any {
  const m: Record<string, unknown> = {
    PROGRAM_ID: PROGRAM_ID.toBase58(),
    USDC_MINT: USDC_MINT_DEVNET.toBase58(),
    SOLANA_RPC_URL: "http://localhost:8899",
  };
  return {
    get: (k: string) => m[k],
    getOrThrow: (k: string) => {
      const v = m[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
  };
}

function fakeConnection(): any {
  return {
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "EBLvr9smm6c7RJYjFc8Tt4Q5sNa1NNqDNxbtxkU8oP4D",
      lastValidBlockHeight: 100_000,
    })),
  };
}

function decodeOpTx(b64: string, expectedDisc: number, configPda: PublicKey) {
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  expect(tx.instructions).toHaveLength(1);
  const ix = tx.instructions[0]!;
  expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
  expect(ix.data[0]).toBe(expectedDisc);
  // First account must be config PDA (for these ops handlers).
  expect(ix.keys[0]!.pubkey.equals(configPda)).toBe(true);
  return ix;
}

describe("OpsService", () => {
  const signer = Keypair.generate().publicKey;
  const [configPda] = getProtocolConfigPda(PROGRAM_ID);

  it("pause builds a real update_config tx with paused=true", async () => {
    const svc = new OpsService(fakeConfig());
    svc.setConnection(fakeConnection());
    const out = await svc.pause({ signerPubkey: signer.toBase58(), paused: true });
    expect(out.unsignedTx.length).toBeGreaterThan(0);
    const ix = decodeOpTx(out.unsignedTx, DISC_UPDATE_CONFIG, configPda);
    // update_config wire: 11 Option<*> tags then 2 frozen-field zero bytes.
    // We're not decoding the wire here — just confirming bytes parse + disc.
    expect(ix.data.length).toBeGreaterThan(2);
  });

  it("update-oracle builds a real update_oracle tx", async () => {
    const svc = new OpsService(fakeConfig());
    svc.setConnection(fakeConnection());
    const newOracle = Keypair.generate().publicKey;
    const out = await svc.updateOracle({
      signerPubkey: signer.toBase58(),
      newOracle: newOracle.toBase58(),
    });
    const ix = decodeOpTx(out.unsignedTx, DISC_UPDATE_ORACLE, configPda);
    // 1 byte disc + 32 byte address
    expect(ix.data.length).toBe(33);
    // Second account is authority (signer)
    expect(ix.keys[1]!.pubkey.equals(signer)).toBe(true);
  });

  it("create-pool builds a real create_pool tx with hostname Borsh-encoded", async () => {
    const svc = new OpsService(fakeConfig());
    svc.setConnection(fakeConnection());
    const hostname = "api.example.com";
    const out = await svc.createPool({
      signerPubkey: signer.toBase58(),
      hostname,
      insuranceRateBps: 250,
      maxCoveragePerCall: "5000000",
    });
    const ix = decodeOpTx(out.unsignedTx, DISC_CREATE_POOL, configPda);
    // Borsh String = u32 LE length + bytes; "api.example.com" has 15 bytes.
    expect(ix.data.readUInt32LE(1)).toBe(15);
    expect(ix.data.slice(5, 5 + 15).toString("utf8")).toBe(hostname);
    // Pool PDA at account index 1.
    const [poolPda] = getCoveragePoolPda(PROGRAM_ID, hostname);
    expect(ix.keys[1]!.pubkey.equals(poolPda)).toBe(true);
  });

  it("update-rates builds a real update_rates tx with u16 LE rate", async () => {
    const svc = new OpsService(fakeConfig());
    svc.setConnection(fakeConnection());
    const hostname = "api.example.com";
    const out = await svc.updateRates({
      signerPubkey: signer.toBase58(),
      hostname,
      newRateBps: 175,
    });
    const ix = decodeOpTx(out.unsignedTx, DISC_UPDATE_RATES, configPda);
    expect(ix.data.length).toBe(3);
    expect(ix.data.readUInt16LE(1)).toBe(175);
  });

  it("returned blockhash matches what Connection returned", async () => {
    const svc = new OpsService(fakeConfig());
    svc.setConnection(fakeConnection());
    const out = await svc.pause({ signerPubkey: signer.toBase58(), paused: true });
    expect(out.recentBlockhash).toBe("EBLvr9smm6c7RJYjFc8Tt4Q5sNa1NNqDNxbtxkU8oP4D");
    expect(out.lastValidBlockHeight).toBe(100_000);
  });
});
