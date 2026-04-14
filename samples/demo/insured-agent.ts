// Pact Network — Insured Agent Demo (Phase 3, full flow)
//
// This script demonstrates the complete "AI agent buys insurance, makes
// calls, gets refunded on failures" pipeline end-to-end, using both SDKs
// (@pact-network/monitor and @pact-network/insurance) against real
// devnet on-chain state + a locally running backend.
//
// It does, in order:
//   1. Load or generate a demo agent Solana keypair
//   2. Fund it with SOL + test USDC (from phantom, the mint authority)
//   3. Enable insurance on a target pool (SPL approve + enable_insurance)
//   4. Run N successful calls through the monitor SDK, tagged with the
//      agent's on-chain pubkey. Each call is recorded as if it cost
//      `CALL_COST_USDC` USDC so premium accounting works.
//   5. Run 1 deliberate failure call (404 endpoint) — same flow, but
//      classification = error. The backend sees a failed payment call
//      and submits a claim on-chain from the pool vault.
//   6. Wait for the backend to flush + settle, then print a summary
//      with pool deltas + explorer links.
//
// Usage:
//   # one-time: start backend, start db, seed pools, set env
//   cd samples/demo && pnpm tsx insured-agent.ts [hostname] [rounds]
//
//   # Examples:
//   pnpm tsx insured-agent.ts api.coingecko.com 5
//   pnpm tsx insured-agent.ts api.dexscreener.com 3
//
// Pre-reqs:
//   - backend running (CRANK_ENABLED=false is FINE; this script exercises
//     the synchronous /records -> maybeCreateClaim -> submit_claim path)
//   - postgres running with schema initialized
//   - devnet pool exists for the target hostname (run seed-devnet-pools.ts)
//   - config.usdcMint is a phantom-owned test mint (default after smoke run)
//   - .env has PACT_API_KEY set (or DEMO_AUTO_GENERATE_KEY=true to self-serve)

import "dotenv/config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAccount,
  createApproveInstruction,
  getAccount,
  getMint,
  mintToChecked,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import BN from "bn.js";
import pg from "pg";
import { pactMonitor } from "@pact-network/monitor";

const { Client } = pg;

// -------- config --------

const HOSTNAME = process.argv[2] || "api.coingecko.com";
const SUCCESS_CALLS = parseInt(process.argv[3] || "3", 10);
// SDK's usdcAmount is in WHOLE USDC (not lamports). It multiplies by 1e6
// internally. So 2 here means $2.00.
const CALL_COST_USDC = 2;
const CALL_COST_LAMPORTS = CALL_COST_USDC * 1_000_000;
const ALLOWANCE_USDC = 20_000_000n; // 20 USDC delegated budget (in lamports)
const INITIAL_USDC = 20_000_000n; // agent starts with 20 USDC in wallet (in lamports)

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.SOLANA_PROGRAM_ID || "2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3",
);
const BACKEND_URL = process.env.PACT_BACKEND_URL || "http://localhost:3001";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://pact:pact@localhost:5433/pact";

const PHANTOM_PATH = path.join(os.homedir(), ".config/solana/phantom-devnet.json");
const ORACLE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../packages/backend/.secrets/oracle-keypair.json",
);

const REAL_ENDPOINTS: Record<string, string> = {
  "api.coingecko.com": "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  "api.dexscreener.com":
    "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
  "api.helius.xyz": "https://api.helius.xyz/v0/token-metadata?api-key=demo",
  "quote-api.jup.ag":
    "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000",
  "solana-mainnet.quiknode.pro": "https://solana-mainnet.quiknode.pro/demo/",
};
const BROKEN_ENDPOINT: Record<string, string> = {
  "api.coingecko.com": "https://api.coingecko.com/api/v3/does-not-exist",
  "api.dexscreener.com": "https://api.dexscreener.com/does/not/exist",
  "api.helius.xyz": "https://api.helius.xyz/v0/does-not-exist",
  "quote-api.jup.ag": "https://quote-api.jup.ag/v6/does-not-exist",
  "solana-mainnet.quiknode.pro": "https://solana-mainnet.quiknode.pro/does-not-exist/",
};

// -------- helpers --------

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

function formatUsdc(raw: bigint | number): string {
  const n = typeof raw === "bigint" ? Number(raw) : raw;
  return `${(n / 1e6).toFixed(4)} USDC`;
}

async function fundFromPhantom(
  connection: Connection,
  phantom: Keypair,
  recipient: PublicKey,
  lamports: number,
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: phantom.publicKey,
      toPubkey: recipient,
      lamports,
    }),
  );
  const sig = await connection.sendTransaction(tx, [phantom]);
  await connection.confirmTransaction(sig, "confirmed");
}

async function ensureApiKey(agentPubkey: string): Promise<string> {
  const existing = process.env.PACT_API_KEY;
  if (existing && existing !== "pact_your_key_here") return existing;

  // Self-serve: generate a key and insert into backend, BOUND to the agent
  // pubkey (Task 1 reads agent_pubkey from the api_keys row server-side).
  const pgClient = new Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  const apiKey = `pact_demo_${randomBytes(6).toString("hex")}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  await pgClient.query(
    `INSERT INTO api_keys (key_hash, label, agent_pubkey) VALUES ($1, $2, $3) ON CONFLICT (key_hash) DO NOTHING`,
    [keyHash, `insured-agent-demo-${Date.now()}`, agentPubkey],
  );
  await pgClient.end();
  log("auth", `self-generated api key ${apiKey.slice(0, 20)}... bound to ${agentPubkey}`);
  return apiKey;
}

// NOTE: no ensureProviderRow helper. The backend's findOrCreateProvider
// (in src/routes/records.ts) creates the providers row automatically when
// the SDK POSTs its first record, and respects any pretty name/category
// previously seeded by src/scripts/seed.ts.

// -------- main --------

async function main() {
  console.log("=== Pact Network — Insured Agent Demo ===");
  log("cfg", `Target hostname: ${HOSTNAME}`);
  log("cfg", `Success calls:   ${SUCCESS_CALLS}`);
  log("cfg", `Call cost each:  ${formatUsdc(CALL_COST_LAMPORTS)}`);
  log("cfg", `RPC:             ${RPC_URL}`);
  log("cfg", `Backend:         ${BACKEND_URL}`);
  console.log("");

  // -------- Solana setup --------
  const phantom = loadKeypair(PHANTOM_PATH);
  const oracle = loadKeypair(ORACLE_PATH);
  log("init", `Phantom: ${phantom.publicKey.toBase58()}`);
  log("init", `Oracle:  ${oracle.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");
  const walletForProvider = new (anchor as any).Wallet(oracle);
  const provider = new (anchor as any).AnchorProvider(connection, walletForProvider, {
    commitment: "confirmed",
  });

  const idlPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../packages/program/target/idl/pact_insurance.json",
  );
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new (Program as any)(idl, provider);

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    PROGRAM_ID,
  );
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(HOSTNAME)],
    PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    PROGRAM_ID,
  );

  const poolAcc = await connection.getAccountInfo(poolPda);
  if (!poolAcc) {
    console.error(
      `[FAIL] no pool exists for hostname="${HOSTNAME}". Run:\n` +
        `       cd packages/backend && npx tsx ../program/scripts/seed-devnet-pools.ts`,
    );
    process.exit(1);
  }

  const config: any = await program.account.protocolConfig.fetch(protocolPda);
  const usdcMint: PublicKey = config.usdcMint;

  const mintInfo = await getMint(connection, usdcMint);
  if (!mintInfo.mintAuthority || !mintInfo.mintAuthority.equals(phantom.publicKey)) {
    console.error(`[FAIL] phantom is not mint authority on ${usdcMint.toBase58()}`);
    process.exit(1);
  }

  // Pool state BEFORE
  const poolBefore: any = await program.account.coveragePool.fetch(poolPda);
  log(
    "pool.before",
    `total_available=${formatUsdc(BigInt(poolBefore.totalAvailable.toString()))} ` +
      `premiums_earned=${formatUsdc(BigInt(poolBefore.totalPremiumsEarned.toString()))} ` +
      `claims_paid=${formatUsdc(BigInt(poolBefore.totalClaimsPaid.toString()))} ` +
      `rate=${poolBefore.insuranceRateBps}bps ` +
      `active_policies=${poolBefore.activePolicies}`,
  );

  // -------- agent setup --------
  const agent = Keypair.generate();
  log("agent", `pubkey: ${agent.publicKey.toBase58()}`);

  await fundFromPhantom(connection, phantom, agent.publicKey, 0.1 * LAMPORTS_PER_SOL);
  const agentAta = await createAccount(connection, phantom, usdcMint, agent.publicKey);
  await mintToChecked(
    connection,
    phantom,
    usdcMint,
    agentAta,
    phantom,
    INITIAL_USDC,
    6,
  );
  log("agent", `funded with ${formatUsdc(INITIAL_USDC)} in ATA ${agentAta.toBase58()}`);

  // -------- enable_insurance --------
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
    PROGRAM_ID,
  );

  const approveIx = createApproveInstruction(
    agentAta,
    poolPda,
    agent.publicKey,
    ALLOWANCE_USDC,
  );
  // H-05: expires_at must be strictly in the future.
  const enableIx = await (program.methods as any)
    .enableInsurance({
      agentId: `demo-${Date.now().toString(36)}`,
      expiresAt: new BN(Math.floor(Date.now() / 1000) + 30 * 86400),
    })
    .accounts({
      config: protocolPda,
      pool: poolPda,
      policy: policyPda,
      agentTokenAccount: agentAta,
      agent: agent.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const enableTx = new Transaction().add(approveIx).add(enableIx);
  const enableSig = await provider.sendAndConfirm(enableTx, [agent]);
  log("enable", `policy active (tx ${enableSig.slice(0, 16)}...)`);
  log("enable", `explorer: https://explorer.solana.com/tx/${enableSig}?cluster=devnet`);
  console.log("");

  // -------- wire up backend (API key only; provider row auto-created on first POST) --------
  const apiKey = await ensureApiKey(agent.publicKey.toBase58());

  // -------- monitor SDK setup --------
  const monitor = pactMonitor({
    apiKey,
    backendUrl: BACKEND_URL,
    syncEnabled: true,
    syncIntervalMs: 3_000,
    latencyThresholdMs: 5_000,
    agentPubkey: agent.publicKey.toBase58(), // Phase 3: tag records with agent pubkey
  });

  const realUrl = REAL_ENDPOINTS[HOSTNAME];
  const brokenUrl = BROKEN_ENDPOINT[HOSTNAME];

  console.log("=== Success calls ===");
  for (let i = 0; i < SUCCESS_CALLS; i++) {
    const start = Date.now();
    try {
      // Manual usdcAmount tells the SDK to record this call as if it cost
      // CALL_COST_USDC whole USDC (SDK multiplies by 1e6 internally) for
      // premium accounting, since public APIs don't include x402 headers.
      const res = await monitor.fetch(
        realUrl,
        {},
        { usdcAmount: CALL_COST_USDC },
      );
      const latency = Date.now() - start;
      log(
        "call",
        `#${i + 1} SUCCESS ${res.status} ${latency}ms — billed ${formatUsdc(CALL_COST_LAMPORTS)}`,
      );
    } catch (err) {
      log("call", `#${i + 1} UNEXPECTED ERROR: ${(err as Error).message}`);
    }
  }

  console.log("");
  console.log("=== Forced failure call ===");
  const failStart = Date.now();
  try {
    const res = await monitor.fetch(
      brokenUrl,
      {},
      { usdcAmount: CALL_COST_USDC },
    );
    const latency = Date.now() - failStart;
    log(
      "call",
      `FAILURE ${res.status} ${latency}ms — payment ${formatUsdc(CALL_COST_LAMPORTS)} (refund claim should fire)`,
    );
  } catch (err) {
    log("call", `FAILURE network error: ${(err as Error).message}`);
  }

  console.log("");
  log("sync", "waiting 6s for monitor sync + backend on-chain settle...");
  await new Promise((r) => setTimeout(r, 6000));

  monitor.shutdown();
  await new Promise((r) => setTimeout(r, 2000));

  // -------- verify --------
  const agentAfter = await getAccount(connection, agentAta);
  const poolAfter: any = await program.account.coveragePool.fetch(poolPda);

  const claimsPaidDelta =
    BigInt(poolAfter.totalClaimsPaid.toString()) -
    BigInt(poolBefore.totalClaimsPaid.toString());

  console.log("");
  console.log("=== Results ===");
  log("agent", `USDC balance:     ${formatUsdc(agentAfter.amount)}`);
  log("agent", `delegated:        ${formatUsdc(agentAfter.delegatedAmount)}`);
  log(
    "pool.after",
    `total_available=${formatUsdc(BigInt(poolAfter.totalAvailable.toString()))} ` +
      `premiums_earned=${formatUsdc(BigInt(poolAfter.totalPremiumsEarned.toString()))} ` +
      `claims_paid=${formatUsdc(BigInt(poolAfter.totalClaimsPaid.toString()))} ` +
      `rate=${poolAfter.insuranceRateBps}bps`,
  );
  log("delta", `pool claims_paid: +${formatUsdc(claimsPaidDelta)}`);
  log(
    "verdict",
    claimsPaidDelta > 0n
      ? "REFUND LANDED ON-CHAIN - the failed call triggered a real on-chain claim and the vault transferred a refund to the agent."
      : "NO REFUND OBSERVED - check backend logs (/tmp/backend.log) for 'Max seed' or 'submit_claim failed'.",
  );

  console.log("");
  console.log(`Open the scorecard pool detail page to see everything:`);
  console.log(`  http://localhost:5173/scorecard/pool/${encodeURIComponent(HOSTNAME)}`);
  console.log("");
  console.log(`Agent wallet on explorer:`);
  console.log(
    `  https://explorer.solana.com/address/${agent.publicKey.toBase58()}?cluster=devnet`,
  );
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
