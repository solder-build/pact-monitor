// Seed devnet with coverage pools for the canonical Pact Network providers.
//
// Idempotent. For each hostname:
//   1. If pool PDA already exists, skip pool creation.
//   2. Mint test USDC into a fresh underwriter ATA.
//   3. Deposit DEPOSIT_USDC into the pool.
//
// Authority for create_pool is the deployer (Phantom) keypair — matches the
// post-Task-5 ProtocolConfig where authority and oracle are distinct keys.
// USDC mint is read live from ProtocolConfig (whatever update_config last set).
//
// Run from `packages/program/`:
//   pnpm dlx tsx scripts/seed-devnet-pools.ts
//
// Pre-reqs:
//   - Phantom keypair at ~/.config/solana/phantom-devnet.json with >= 5 SOL on devnet
//   - Oracle keypair at ../backend/.secrets/oracle-keypair.json (will be funded from phantom)
//   - Protocol initialized on devnet (already done)
//   - config.usdcMint points at a mint where the phantom wallet is the mint authority
//     (the smoke script created such a mint; reuse via SMOKE_TEST_MINT env var if needed)

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  mintToChecked,
  getMint,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3");

const HOSTNAMES = [
  "api.helius.xyz",
  "solana-mainnet.quiknode.pro",
  "quote-api.jup.ag",
  "api.coingecko.com",
  "api.dexscreener.com",
];

const DEPOSIT_USDC = 100_000_000n; // 100 USDC (6 decimals)

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function deriveProtocolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol")], PROGRAM_ID);
}

function derivePoolPda(hostname: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(hostname)],
    PROGRAM_ID,
  );
}

function deriveVaultPda(poolPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    PROGRAM_ID,
  );
}

function derivePositionPda(poolPda: PublicKey, underwriter: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), poolPda.toBuffer(), underwriter.toBuffer()],
    PROGRAM_ID,
  );
}

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

async function fundFromPhantom(
  connection: Connection,
  phantom: Keypair,
  recipient: PublicKey,
  lamports: number,
) {
  const tx = new (await import("@solana/web3.js")).Transaction().add(
    SystemProgram.transfer({
      fromPubkey: phantom.publicKey,
      toPubkey: recipient,
      lamports,
    }),
  );
  const sig = await connection.sendTransaction(tx, [phantom]);
  await connection.confirmTransaction(sig, "confirmed");
}

async function main() {
  const phantomPath = path.join(os.homedir(), ".config/solana/phantom-devnet.json");
  const oraclePath = path.resolve(__dirname, "../../backend/.secrets/oracle-keypair.json");
  const phantom = loadKeypair(phantomPath);
  const oracle = loadKeypair(oraclePath);

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(oracle);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, "../target/idl/pact_insurance.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider);

  const [protocolPda] = deriveProtocolPda();

  log("init", `Program: ${PROGRAM_ID.toBase58()}`);
  log("init", `Protocol PDA: ${protocolPda.toBase58()}`);
  log("init", `Phantom: ${phantom.publicKey.toBase58()}`);
  log("init", `Oracle:  ${oracle.publicKey.toBase58()}`);

  const oracleBalance = await connection.getBalance(oracle.publicKey);
  if (oracleBalance < 0.5 * LAMPORTS_PER_SOL) {
    log("init", `Oracle balance ${oracleBalance / LAMPORTS_PER_SOL} SOL — topping up from phantom`);
    await fundFromPhantom(connection, phantom, oracle.publicKey, 1 * LAMPORTS_PER_SOL);
  }

  const config: any = await (program.account as any).protocolConfig.fetch(protocolPda);
  const usdcMint: PublicKey = config.usdcMint;
  log("init", `config.usdcMint: ${usdcMint.toBase58()}`);

  // Sanity-check: phantom must be the mint authority for us to mint test USDC
  const mintInfo = await getMint(connection, usdcMint);
  if (!mintInfo.mintAuthority || !mintInfo.mintAuthority.equals(phantom.publicKey)) {
    console.error(
      `[FAIL] phantom is not mint authority on ${usdcMint.toBase58()}. ` +
        `mint authority = ${mintInfo.mintAuthority?.toBase58() ?? "null"}. ` +
        `Run the smoke script first to create a mint where phantom is authority, ` +
        `or run update_config to point config.usdcMint at a phantom-owned test mint.`,
    );
    process.exit(1);
  }

  for (const hostname of HOSTNAMES) {
    log("pool", `=== ${hostname} ===`);

    const [poolPda] = derivePoolPda(hostname);
    const [vaultPda] = deriveVaultPda(poolPda);

    log("pool", `pool PDA: ${poolPda.toBase58()}`);
    log("pool", `vault PDA: ${vaultPda.toBase58()}`);

    // Skip create_pool if pool already exists
    const existingPool = await connection.getAccountInfo(poolPda);
    if (existingPool) {
      log("pool", "already exists, skipping create_pool");
    } else {
      try {
        const sig = await (program.methods as any)
          .createPool({
            providerHostname: hostname,
            insuranceRateBps: null,
            maxCoveragePerCall: null,
          })
          .accounts({
            config: protocolPda,
            pool: poolPda,
            vault: vaultPda,
            usdcMint,
            authority: phantom.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([phantom])
          .rpc();
        log("pool", `created (sig ${sig})`);
      } catch (err: any) {
        log("FAIL", `create_pool failed for ${hostname}: ${err.message ?? err}`);
        continue;
      }
    }

    // Fresh underwriter per pool keeps things predictable on re-runs
    const underwriter = Keypair.generate();
    log("uw", `underwriter: ${underwriter.publicKey.toBase58()}`);
    await fundFromPhantom(connection, phantom, underwriter.publicKey, 0.05 * LAMPORTS_PER_SOL);

    const underwriterAta = await createAccount(
      connection,
      phantom,
      usdcMint,
      underwriter.publicKey,
    );
    log("uw", `ATA: ${underwriterAta.toBase58()}`);

    await mintToChecked(
      connection,
      phantom,
      usdcMint,
      underwriterAta,
      phantom,
      DEPOSIT_USDC,
      6,
    );
    log("uw", `minted ${DEPOSIT_USDC} (raw)`);

    const [positionPda] = derivePositionPda(poolPda, underwriter.publicKey);

    try {
      const sig = await (program.methods as any)
        .deposit(new BN(DEPOSIT_USDC.toString()))
        .accounts({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          position: positionPda,
          underwriterTokenAccount: underwriterAta,
          underwriter: underwriter.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([underwriter])
        .rpc();
      log("uw", `deposit confirmed (sig ${sig})`);
    } catch (err: any) {
      log("FAIL", `deposit failed for ${hostname}: ${err.message ?? err}`);
      continue;
    }

    const pool: any = await (program.account as any).coveragePool.fetch(poolPda);
    log(
      "summary",
      `${hostname} totalDeposited=${pool.totalDeposited.toString()} totalAvailable=${pool.totalAvailable.toString()} rate=${pool.insuranceRateBps}bps`,
    );

    await new Promise((r) => setTimeout(r, 750));
  }

  console.log("\nSEED_DONE=true");
  console.log(`SEED_PROTOCOL_PDA=${protocolPda.toBase58()}`);
  console.log(`SEED_USDC_MINT=${usdcMint.toBase58()}`);
  for (const hostname of HOSTNAMES) {
    const [poolPda] = derivePoolPda(hostname);
    console.log(`SEED_POOL[${hostname}]=${poolPda.toBase58()}`);
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
