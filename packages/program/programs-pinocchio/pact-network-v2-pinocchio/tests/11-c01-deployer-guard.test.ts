/**
 * C-01 deployer-guard test — the only file that loads the NO-BYPASS
 * binary (`pact_network_v2_pinocchio_no_bypass.so`).
 *
 * The hardened production binary rejects `initialize_protocol` calls
 * signed by anyone other than the baked-in `DEPLOYER_PUBKEY`
 * (`lib.rs:24` + `instructions/initialize_protocol.rs:80-87`). With
 * the `unsafe-bypass-deployer` Cargo feature DISABLED, the check is
 * compile-time enabled.
 *
 * Without the deployer's private key we cannot exercise the happy path
 * (which is correct — that's the entire point of the guard). The only
 * test here is the rejection path: a non-deployer signer attempts
 * `initialize_protocol` and the program returns 6024
 * UnauthorizedDeployer.
 *
 * Build requirement (see README.md): both `pact_network_v2_pinocchio.so`
 * (bypass) and `pact_network_v2_pinocchio_no_bypass.so` (no bypass) must
 * exist on disk. The `cargo build-sbf` step in CI / local has to copy
 * the no-bypass artifact to a distinct filename so both variants
 * coexist in `target/deploy/`.
 *
 * **Production safety reminder**: the `unsafe-bypass-deployer` feature
 * MUST NEVER ship in a deployed artifact. The mainnet / devnet binary
 * is the default-features build. Verified-build CI jobs that produce
 * production artifacts explicitly avoid this flag.
 */
import { describe, expect, it } from "vitest";
import { LiteSVM } from "litesvm";
import { Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  buildInitializeProtocolIx,
  getProtocolConfigPda,
  USDC_MINT_DEVNET,
} from "@q3labs/pact-protocol-v2-client";
import {
  generateKeypair,
  loadProgram,
  sendAndExtractCode,
  setupUsdcMint,
} from "./helpers.js";

describe("C-01 deployer guard (no-bypass binary)", () => {
  it("rejects a non-DEPLOYER_PUBKEY signer with 6024 UnauthorizedDeployer", () => {
    const svm = new LiteSVM();
    loadProgram(svm, { bypass: false });

    const stranger = generateKeypair(svm);
    const mintAuthority = generateKeypair(svm);
    setupUsdcMint(svm, mintAuthority);
    const [configPda] = getProtocolConfigPda(PROGRAM_ID);

    const ix = buildInitializeProtocolIx({
      programId: PROGRAM_ID,
      configPda,
      deployer: stranger.publicKey,
      authority: stranger.publicKey,
      oracle: generateKeypair(svm).publicKey,
      treasury: generateKeypair(svm).publicKey,
      usdcMint: USDC_MINT_DEVNET,
    });

    expect(sendAndExtractCode(svm, new Transaction().add(ix), stranger)).toBe(6024);
  });
});
