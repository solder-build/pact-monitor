import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";

// Shared authority keypair used across all test files in the same mocha run.
// Generated once at module load so protocol.ts and pool.ts share it.
export const authority: Keypair = Keypair.generate();
export const oracle: Keypair = Keypair.generate();
export const treasury: PublicKey = Keypair.generate().publicKey;

let cachedUsdcMint: PublicKey | null = null;
let initialized = false;

export interface ProtocolHandles {
  protocolPda: PublicKey;
  authority: Keypair;
  oracle: Keypair;
  treasury: PublicKey;
  usdcMint: PublicKey;
}

export async function getOrInitProtocol(
  program: Program<PactInsurance>,
  provider: anchor.AnchorProvider
): Promise<ProtocolHandles> {
  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  if (!initialized) {
    // The authority pays for downstream init calls (e.g. CreatePool), so it
    // needs SOL on the local validator before the first instruction.
    const airdropSig = await provider.connection.requestAirdrop(
      authority.publicKey,
      10_000_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Tests assume a fresh validator. If a stale ProtocolConfig PDA is still
    // on-chain from a previous run, fail loudly — the in-memory authority
    // keypair is regenerated each run and won't match the persisted authority.
    const existing = await provider.connection.getAccountInfo(protocolPda);
    if (existing) {
      throw new Error(
        "ProtocolConfig PDA already exists on-chain. Restart solana-test-validator (rm -rf test-ledger) before running tests."
      );
    }

    const oracleAirdrop = await provider.connection.requestAirdrop(
      oracle.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(oracleAirdrop);

    cachedUsdcMint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    await program.methods
      .initializeProtocol({
        authority: authority.publicKey,
        oracle: oracle.publicKey,
        treasury,
        usdcMint: cachedUsdcMint,
      })
      .accounts({
        config: protocolPda,
        deployer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    initialized = true;
  }

  return {
    protocolPda,
    authority,
    oracle,
    treasury,
    usdcMint: cachedUsdcMint!,
  };
}
