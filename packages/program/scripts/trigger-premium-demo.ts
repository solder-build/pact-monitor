// Trigger a complete premium-settlement flow against an existing devnet pool.
//
// What this does:
//   1. Generate fresh agent keypair, fund SOL + mint 10 test USDC
//   2. SPL approve(pool_pda, 10 USDC) + enable_insurance atomically
//   3. Ensure provider row + API key exist in backend
//   4. POST N synthetic successful call records (classification=success)
//      with agent_pubkey attached and large payment_amount values
//   5. Wait for the crank's next run (or fire manually if `--manual` flag)
//   6. Check agent's USDC balance + delegated_amount to verify premium pulled
//   7. Check pool.total_premiums_earned on-chain
//
// Usage (from packages/backend/ because it needs pg):
//   npx tsx ../program/scripts/trigger-premium-demo.ts <hostname> [call_count]
//
// Example:
//   npx tsx ../program/scripts/trigger-premium-demo.ts api.dexscreener.com 5
//
// Pre-reqs:
//   - devnet pool exists for <hostname> (run seed-devnet-pools.ts)
//   - backend running at BACKEND_URL (default localhost:3001)
//   - postgres reachable via DATABASE_URL
//   - phantom keypair at ~/.config/solana/phantom-devnet.json with >= 0.3 SOL
//   - config.usdcMint must have phantom as mint authority
//   - CRANK_ENABLED=true in backend .env (otherwise nothing settles and
//     this script will report a pending callValue that never fires)

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import pg from "pg";

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3");
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://pact:pact@localhost:5433/pact";

const ALLOWANCE_USDC = 10_000_000n;
const AGENT_INITIAL_USDC = 10_000_000n;
const CALL_VALUE_EACH = 2_000_000; // 2 USDC per call

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

async function fundSol(connection: Connection, payer: Keypair, recipient: PublicKey, lamports: number) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports }),
  );
  const sig = await connection.sendTransaction(tx, [payer]);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function main() {
  const hostname = process.argv[2];
  const callCount = parseInt(process.argv[3] ?? "5", 10);
  if (!hostname) {
    console.error("Usage: npx tsx ../program/scripts/trigger-premium-demo.ts <hostname> [call_count]");
    process.exit(1);
  }

  log("init", `Hostname: ${hostname}`);
  log("init", `Call count: ${callCount}`);
  log("init", `Call value each: ${CALL_VALUE_EACH} (${CALL_VALUE_EACH / 1_000_000} USDC)`);

  const phantom = loadKeypair(path.join(os.homedir(), ".config/solana/phantom-devnet.json"));
  const oracle = loadKeypair(path.resolve(__dirname, "../../backend/.secrets/oracle-keypair.json"));
  log("init", `Phantom: ${phantom.publicKey.toBase58()}`);
  log("init", `Oracle:  ${oracle.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(oracle);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, "../target/idl/pact_insurance.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider);

  const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], PROGRAM_ID);
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(hostname)],
    PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    PROGRAM_ID,
  );

  if (!(await connection.getAccountInfo(poolPda))) {
    console.error(`[FAIL] no pool exists for hostname="${hostname}"`);
    process.exit(1);
  }

  const config: any = await (program.account as any).protocolConfig.fetch(protocolPda);
  const usdcMint: PublicKey = config.usdcMint;

  const mintInfo = await getMint(connection, usdcMint);
  if (!mintInfo.mintAuthority || !mintInfo.mintAuthority.equals(phantom.publicKey)) {
    console.error(`[FAIL] phantom is not mint authority on config.usdcMint`);
    process.exit(1);
  }

  // Fresh agent
  const agent = Keypair.generate();
  log("agent", `pubkey: ${agent.publicKey.toBase58()}`);
  await fundSol(connection, phantom, agent.publicKey, 0.1 * LAMPORTS_PER_SOL);
  const agentAta = await createAccount(connection, phantom, usdcMint, agent.publicKey);
  await mintToChecked(connection, phantom, usdcMint, agentAta, phantom, AGENT_INITIAL_USDC, 6);
  log("agent", `ATA: ${agentAta.toBase58()} = ${AGENT_INITIAL_USDC} raw`);

  // Policy
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
    PROGRAM_ID,
  );

  const approveIx = createApproveInstruction(agentAta, poolPda, agent.publicKey, ALLOWANCE_USDC);
  // H-05: expires_at must be strictly in the future.
  const expiresAt = new BN(Math.floor(Date.now() / 1000) + 30 * 86400);
  const enableIx = await (program.methods as any)
    .enableInsurance({
      agentId: `prem-${Date.now().toString(36)}`,
      expiresAt,
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
  log("enable", `policy active (sig ${enableSig.slice(0, 16)}...)`);

  // Backend provider row + api key
  const pgClient = new Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  const providerRow = await pgClient.query(
    `INSERT INTO providers (name, category, base_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (base_url) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [hostname.split(".")[0] ?? hostname, "Demo", hostname],
  );
  const providerId = providerRow.rows[0].id;

  const apiKey = `pact_prem_${Math.random().toString(36).slice(2, 14)}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  await pgClient.query(
    `INSERT INTO api_keys (key_hash, label) VALUES ($1, $2) ON CONFLICT (key_hash) DO NOTHING`,
    [keyHash, `prem-demo-${Date.now()}`],
  );
  await pgClient.end();
  log("db", `provider ${providerId.slice(0, 8)}, api key ${apiKey.slice(0, 16)}...`);

  // POST N successful call records
  const records = [];
  for (let i = 0; i < callCount; i++) {
    records.push({
      hostname,
      endpoint: `/api/v3/prem-demo/${i}`,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      status_code: 200,
      latency_ms: 150 + i * 10,
      classification: "success",
      payment_protocol: "x402",
      payment_amount: CALL_VALUE_EACH,
      payment_asset: "USDC",
      payment_network: "solana:devnet",
      payer_address: agent.publicKey.toBase58(),
      recipient_address: config.treasury.toBase58(),
      tx_hash: null,
      settlement_success: true,
      agent_pubkey: agent.publicKey.toBase58(),
    });
  }

  const res = await fetch(`${BACKEND_URL}/api/v1/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ records }),
  });
  const resBody: any = await res.json();
  log("post", `accepted ${resBody.accepted} of ${callCount}`);
  if (!res.ok) {
    console.error("[FAIL] backend rejected records", resBody);
    process.exit(1);
  }

  // Check expected premium math
  const totalCallValue = BigInt(callCount) * BigInt(CALL_VALUE_EACH);
  const rateBps = 25n; // default from seeded pool
  const grossPremium = (totalCallValue * rateBps) / 10_000n;
  const protocolFeeBps = BigInt(config.protocolFeeBps);
  const protocolFee = (grossPremium * protocolFeeBps) / 10_000n;
  const poolPremium = grossPremium - protocolFee;

  log("math", `total call_value: ${totalCallValue} (${Number(totalCallValue) / 1e6} USDC)`);
  log("math", `rate: ${rateBps} bps`);
  log("math", `gross_premium expected: ${grossPremium} (${Number(grossPremium) / 1e6} USDC)`);
  log("math", `protocol_fee (${protocolFeeBps}bps): ${protocolFee}`);
  log("math", `pool_premium: ${poolPremium}`);

  // Record baseline
  const beforeAgent = await getAccount(connection, agentAta);
  const beforeVault = await getAccount(connection, vaultPda);
  log("before", `agent balance: ${beforeAgent.amount}`);
  log("before", `agent delegated: ${beforeAgent.delegatedAmount}`);
  log("before", `vault balance:   ${beforeVault.amount}`);

  // Wait for crank to fire. Initial fire is staggered 5s after startup.
  // In practice we poll for up to 30s for the first settlement.
  log("wait", "polling up to 60s for crank settle_premium...");
  const startWait = Date.now();
  let settled = false;
  let afterAgent = beforeAgent;
  let afterVault = beforeVault;
  while (Date.now() - startWait < 60_000) {
    await new Promise((r) => setTimeout(r, 3000));
    afterAgent = await getAccount(connection, agentAta);
    afterVault = await getAccount(connection, vaultPda);
    if (afterAgent.amount !== beforeAgent.amount) {
      settled = true;
      break;
    }
    process.stdout.write(".");
  }
  console.log("");

  log("after", `agent balance: ${afterAgent.amount}`);
  log("after", `agent delegated: ${afterAgent.delegatedAmount}`);
  log("after", `vault balance:   ${afterVault.amount}`);

  const agentDelta = beforeAgent.amount - afterAgent.amount;
  const vaultDelta = afterVault.amount - beforeVault.amount;
  log("delta", `agent -${agentDelta} (expected ${grossPremium})`);
  log("delta", `vault +${vaultDelta} (expected ${poolPremium})`);

  if (!settled) {
    console.error("\n[FAIL] no premium settlement observed within 60s");
    console.error("       check CRANK_ENABLED=true in backend .env");
    console.error("       check /tmp/backend.log for 'Premium settler' messages");
    process.exit(1);
  }

  const pool: any = await (program.account as any).coveragePool.fetch(poolPda);
  log("pool", `totalPremiumsEarned: ${pool.totalPremiumsEarned.toString()}`);
  log("pool", `totalAvailable:      ${pool.totalAvailable.toString()}`);

  console.log("\n=== PREMIUM_DEMO_DONE ===");
  console.log(`DEMO_HOSTNAME=${hostname}`);
  console.log(`DEMO_AGENT_PUBKEY=${agent.publicKey.toBase58()}`);
  console.log(`DEMO_POLICY_PDA=${policyPda.toBase58()}`);
  console.log(`DEMO_AGENT_SPENT=${agentDelta}`);
  console.log(`DEMO_VAULT_EARNED=${vaultDelta}`);
  console.log(`DEMO_MATH_OK=${agentDelta === grossPremium && vaultDelta === poolPremium}`);
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
