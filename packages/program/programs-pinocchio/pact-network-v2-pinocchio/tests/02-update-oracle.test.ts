/**
 * `update_oracle` (disc 2) — rotate `config.oracle`.
 *
 * Covered:
 *   - happy: oracle field updates; authority + config unchanged
 *   - reject new_oracle == authority (6030 InvalidOracleKey — C-02 split)
 *   - reject zero address (6030 InvalidOracleKey)
 *   - reject non-authority signer (6018 Unauthorized)
 */
import { describe, expect, it } from "vitest";
import { LiteSVM } from "litesvm";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  buildUpdateOracleIx,
  decodeProtocolConfig,
} from "@q3labs/pact-protocol-v2-client";
import { airdrop, getAccountData, loadProgram, sendAndExtractCode } from "./helpers.js";
import { setupProtocol } from "./fixtures.js";

describe("update_oracle — happy path", () => {
  it("updates config.oracle and leaves other fields intact", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const newOracle = Keypair.generate().publicKey;

    const ix = buildUpdateOracleIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      newOracle,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBeUndefined();

    const cfg = decodeProtocolConfig(getAccountData(svm, proto.configPda)!);
    expect(cfg.oracle).toBe(newOracle.toBase58());
    expect(cfg.authority).toBe(proto.authority.publicKey.toBase58());
    expect(cfg.treasury).toBe(proto.treasury.publicKey.toBase58());
  });
});

describe("update_oracle — InvalidOracleKey (6030)", () => {
  it("rejects new_oracle == config.authority (would collapse C-02 split)", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);

    const ix = buildUpdateOracleIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      newOracle: proto.authority.publicKey,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBe(6030);
  });

  it("rejects the zero address (default pubkey)", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);

    const zero = new PublicKey(new Uint8Array(32));
    const ix = buildUpdateOracleIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: proto.authority.publicKey,
      newOracle: zero,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), proto.authority)).toBe(6030);
  });
});

describe("update_oracle — Unauthorized (6018)", () => {
  it("rejects when the signer is not config.authority", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const proto = setupProtocol(svm);
    const stranger = Keypair.generate();
    airdrop(svm, stranger.publicKey);

    const ix = buildUpdateOracleIx({
      programId: PROGRAM_ID,
      configPda: proto.configPda,
      authority: stranger.publicKey,
      newOracle: Keypair.generate().publicKey,
    });
    expect(sendAndExtractCode(svm, new Transaction().add(ix), stranger)).toBe(6018);
  });
});
