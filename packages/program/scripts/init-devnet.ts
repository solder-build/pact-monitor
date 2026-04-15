import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Phantom-controlled test USDC mint for Pact devnet (created 2026-04-14 via
// scripts/create-test-mint.mjs). H-03 freezes config.usdc_mint post-init, so
// this MUST be a mint where the deploying wallet is the mint authority — we
// can't update_config it later. For mainnet, swap to the canonical USDC mint.
const DEVNET_USDC_MINT = new PublicKey("5vcEdU8fBksfRH42wrebUV6dNEENPbdaBtAmw79ZNuSE");

function loadKeypair(p: string): Keypair {
  const resolved = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/phantom-devnet.json");
  const oracleKeypairPath =
    process.env.ORACLE_KEYPAIR_PATH ??
    path.join(
      __dirname,
      "../../../packages/backend/.secrets/oracle-keypair.json"
    );

  const deployer = loadKeypair(walletPath);
  const oracle = loadKeypair(oracleKeypairPath);

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(deployer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.PactInsurance as Program<PactInsurance>;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  console.log("Deployer (Phantom):", deployer.publicKey.toString());
  console.log("Authority (= deployer):", deployer.publicKey.toString());
  console.log("Oracle (claim signer):", oracle.publicKey.toString());
  console.log("Treasury:          ", deployer.publicKey.toString(), "(= deployer)");
  console.log("USDC mint (devnet):", DEVNET_USDC_MINT.toString());
  console.log("Protocol PDA:      ", protocolPda.toString());
  console.log("Program ID:        ", program.programId.toString());
  console.log("");

  // Check if already initialized
  try {
    const existing = await (program.account as any).protocolConfig.fetch(protocolPda);
    console.log("Protocol already initialized:");
    console.log("  authority:      ", existing.authority.toString());
    console.log("  treasury:       ", existing.treasury.toString());
    console.log("  usdc_mint:      ", existing.usdcMint.toString());
    console.log("  protocol_fee:   ", existing.protocolFeeBps, "bps");
    console.log("  paused:         ", existing.paused);
    return;
  } catch (_) {
    console.log("Protocol not initialized yet. Initializing...");
  }

  const sig = await (program.methods as any)
    .initializeProtocol({
      authority: deployer.publicKey,
      oracle: oracle.publicKey,
      treasury: deployer.publicKey,
      usdcMint: DEVNET_USDC_MINT,
    })
    .accounts({
      config: protocolPda,
      deployer: deployer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("\nInitialized. Transaction:", sig);
  console.log("Explorer:", `https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  const config = await (program.account as any).protocolConfig.fetch(protocolPda);
  console.log("\nFinal config:");
  console.log("  authority:            ", config.authority.toString());
  console.log("  treasury:             ", config.treasury.toString());
  console.log("  usdc_mint:            ", config.usdcMint.toString());
  console.log("  protocol_fee_bps:     ", config.protocolFeeBps);
  console.log("  min_pool_deposit:     ", config.minPoolDeposit.toString(), "(100 USDC)");
  console.log("  withdrawal_cooldown:  ", config.withdrawalCooldownSeconds.toString(), "(7 days)");
  console.log("  aggregate_cap_bps:    ", config.aggregateCapBps, "(30%)");
  console.log("  aggregate_cap_window: ", config.aggregateCapWindowSeconds.toString(), "(24h)");

  // Ensure the treasury's USDC ATA exists on-chain. settle_premium requires
  // this account to be initialized so the 15% protocol fee has somewhere to
  // land. Without it, every crank cycle would fail with AccountNotInitialized.
  // Idempotent — createIfNotExists.
  const treasuryAta = await getOrCreateAssociatedTokenAccount(
    connection,
    deployer,
    DEVNET_USDC_MINT,
    config.treasury as PublicKey,
  );
  console.log("  treasury_token_account:", treasuryAta.address.toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
