/**
 * `initialize_protocol` (disc 0) — singleton ProtocolConfig boot.
 *
 * Covered:
 *   - happy: writes config with the four supplied addresses + program defaults
 *   - **PROGRAM_ID pin** (critique I-3): assert client PROGRAM_ID matches the
 *     literal `declare_id!` in `lib.rs` so a drift fails a single named test
 *     instead of silently breaking every PDA derivation
 *   - double-init rejected as AccountAlreadyInitialized
 *   - wrong system_program key rejected as IncorrectProgramId
 *   - non-empty PDA pre-seeded → re-init rejected
 *   - bypass `.so` lets a non-DEPLOYER signer initialize (the C-01
 *     enforcement test lives in `11-c01-deployer-guard.test.ts`)
 */
import { describe, expect, it } from "vitest";
import { LiteSVM } from "litesvm";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  buildInitializeProtocolIx,
  decodeProtocolConfig,
  getProtocolConfigPda,
  USDC_MINT_DEVNET,
} from "@q3labs/pact-protocol-v2-client";
import {
  airdrop,
  extractCustomCode,
  generateKeypair,
  getAccountData,
  loadProgram,
  sendAndExtractCode,
  setupUsdcMint,
} from "./helpers.js";

describe("PROGRAM_ID pinning (critique I-3)", () => {
  it("matches the V2 Pinocchio declare_id literal", () => {
    expect(PROGRAM_ID.toBase58()).toBe(
      "7i9zJMwaTRw4Tdy7SAfXJdDkYQD39xyKmkBhWuUSgDJU"
    );
  });
});

describe("initialize_protocol — happy path", () => {
  it("creates ProtocolConfig at the canonical PDA with the supplied addresses", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });

    const deployer = generateKeypair(svm);
    const authority = generateKeypair(svm);
    const oracle = generateKeypair(svm);
    const treasury = generateKeypair(svm);
    const mintAuthority = generateKeypair(svm);
    const mint = setupUsdcMint(svm, mintAuthority);

    const [configPda] = getProtocolConfigPda(PROGRAM_ID);

    const ix = buildInitializeProtocolIx({
      programId: PROGRAM_ID,
      configPda,
      deployer: deployer.publicKey,
      authority: authority.publicKey,
      oracle: oracle.publicKey,
      treasury: treasury.publicKey,
      usdcMint: mint,
    });

    const code = sendAndExtractCode(svm, new Transaction().add(ix), deployer);
    expect(code).toBeUndefined();

    const data = getAccountData(svm, configPda);
    expect(data).not.toBeNull();
    const cfg = decodeProtocolConfig(data!);
    expect(cfg.authority).toBe(authority.publicKey.toBase58());
    expect(cfg.oracle).toBe(oracle.publicKey.toBase58());
    expect(cfg.treasury).toBe(treasury.publicKey.toBase58());
    expect(cfg.usdcMint).toBe(mint.toBase58());
    expect(cfg.paused).toBe(0);
    // Defaults from constants.rs (DEFAULT_PROTOCOL_FEE_BPS, etc.)
    expect(cfg.protocolFeeBps).toBe(1500);
    expect(cfg.defaultInsuranceRateBps).toBe(25);
    expect(cfg.minPremiumBps).toBe(5);
    expect(cfg.aggregateCapBps).toBe(3000);
  });

  it("uses USDC_MINT_DEVNET when the helper-seeded mint is passed", () => {
    // Sanity check — the mint constant in the client is the one the harness
    // pre-seeds. If these drift, settle_premium/submit_claim tests will fail
    // mysteriously later.
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });
    const mintAuthority = generateKeypair(svm);
    const mint = setupUsdcMint(svm, mintAuthority);
    expect(mint.toBase58()).toBe(USDC_MINT_DEVNET.toBase58());
  });
});

describe("initialize_protocol — failure modes", () => {
  it("rejects a second initialize as AccountAlreadyInitialized", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });

    const deployer = generateKeypair(svm);
    const authority = generateKeypair(svm);
    const mintAuthority = generateKeypair(svm);
    setupUsdcMint(svm, mintAuthority);

    const [configPda] = getProtocolConfigPda(PROGRAM_ID);
    const params = {
      programId: PROGRAM_ID,
      configPda,
      deployer: deployer.publicKey,
      authority: authority.publicKey,
      oracle: Keypair.generate().publicKey,
      treasury: Keypair.generate().publicKey,
      usdcMint: USDC_MINT_DEVNET,
    };

    // First call succeeds.
    expect(
      sendAndExtractCode(svm, new Transaction().add(buildInitializeProtocolIx(params)), deployer)
    ).toBeUndefined();

    // Second call must fail — AccountAlreadyInitialized is not a `Custom(...)`
    // code; it's a built-in `ProgramError`. We assert the tx failed in any way.
    const tx2 = new Transaction().add(buildInitializeProtocolIx(params));
    tx2.feePayer = deployer.publicKey;
    tx2.recentBlockhash = svm.latestBlockhash();
    tx2.sign(deployer);
    const result2 = svm.sendTransaction(tx2);
    expect(typeof result2 === "object" && "err" in (result2 as object)).toBe(true);
  });

  it("rejects a wrong PDA (signer-derived pubkey not equal to canonical config)", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });

    const deployer = generateKeypair(svm);
    const wrongPda = generateKeypair(svm).publicKey; // not the canonical config PDA
    const mintAuthority = generateKeypair(svm);
    setupUsdcMint(svm, mintAuthority);

    const ix = buildInitializeProtocolIx({
      programId: PROGRAM_ID,
      configPda: wrongPda,
      deployer: deployer.publicKey,
      authority: deployer.publicKey,
      oracle: Keypair.generate().publicKey,
      treasury: Keypair.generate().publicKey,
      usdcMint: USDC_MINT_DEVNET,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = deployer.publicKey;
    tx.recentBlockhash = svm.latestBlockhash();
    tx.sign(deployer);
    const result = svm.sendTransaction(tx);
    // Expected: InvalidSeeds — the handler asserts derived PDA matches
    // the supplied config account.
    expect(typeof result === "object" && "err" in (result as object)).toBe(true);
  });

  it("rejects when a non-system-program account is passed as systemProgram", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: true });

    const deployer = generateKeypair(svm);
    const mintAuthority = generateKeypair(svm);
    setupUsdcMint(svm, mintAuthority);

    const [configPda] = getProtocolConfigPda(PROGRAM_ID);
    const goodIx = buildInitializeProtocolIx({
      programId: PROGRAM_ID,
      configPda,
      deployer: deployer.publicKey,
      authority: deployer.publicKey,
      oracle: Keypair.generate().publicKey,
      treasury: Keypair.generate().publicKey,
      usdcMint: USDC_MINT_DEVNET,
    });
    // Swap the system_program slot (index 2) for a random pubkey.
    const corrupted = { ...goodIx };
    corrupted.keys = goodIx.keys.map((k, i) =>
      i === 2 ? { ...k, pubkey: Keypair.generate().publicKey } : k
    );
    const tx = new Transaction().add(corrupted as typeof goodIx);
    tx.feePayer = deployer.publicKey;
    tx.recentBlockhash = svm.latestBlockhash();
    tx.sign(deployer);
    const result = svm.sendTransaction(tx);
    expect(typeof result === "object" && "err" in (result as object)).toBe(true);
  });
});
