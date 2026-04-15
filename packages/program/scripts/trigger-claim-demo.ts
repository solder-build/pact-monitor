// Trigger a complete failure-to-refund flow against an existing devnet pool.
//
// Lower-level plumbing test: POSTs a hand-rolled fake failure record directly
// to /api/v1/records, skipping the real SDK wrapper. Useful for testing the
// backend ingestion + auto-claim path in isolation. For the full SDK-driven
// happy+bad case demo, see samples/demo/insured-agent.ts (that one uses
// PactMonitor.fetch() against real URLs).
//
// What this does (in order):
//   1. Generate a throwaway agent keypair
//   2. Fund it with SOL (from phantom) + 5 test USDC (minted from phantom)
//   3. Run `spl_token::approve` + `enable_insurance` as a single atomic tx
//      to create an on-chain Policy for (agent, pool)
//   4. Provision a Pact API key via POST /api/v1/admin/keys (HTTP, no pg)
//   5. POST a fake failed call record to backend /api/v1/records
//   6. Backend's `maybeCreateClaim` detects the failure, sees the active
//      policy, and calls `submit_claim` on-chain
//   7. Re-read on-chain pool state + agent ATA to verify the refund landed
//
// Usage (from packages/backend/):
//   pnpm exec tsx ../program/scripts/trigger-claim-demo.ts <hostname>
//
// Pre-reqs:
//   - devnet pool must already exist for <hostname> (run seed-devnet-pools.ts)
//   - backend must be running at BACKEND_URL (default http://localhost:3001)
//   - ADMIN_TOKEN env var must match the backend's ADMIN_TOKEN
//   - phantom keypair at ~/.config/solana/phantom-devnet.json with >= 0.3 SOL
//   - config.usdcMint must be a mint where phantom is mint authority

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
  TOKEN_PROGRAM_ID,
  createAccount,
  createApproveInstruction,
  mintToChecked,
  getAccount,
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
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

const ALLOWANCE_USDC = 5_000_000n; // 5 USDC delegation cap
const AGENT_INITIAL_USDC = 5_000_000n; // 5 USDC in agent wallet
const FAKE_PAYMENT_AMOUNT = 500_000; // 0.5 USDC call cost (refund is capped at max_coverage_per_call = 1 USDC)

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function fundSol(
  connection: Connection,
  payer: Keypair,
  recipient: PublicKey,
  lamports: number,
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports,
    }),
  );
  const sig = await connection.sendTransaction(tx, [payer]);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function main() {
  const hostname = process.argv[2];
  if (!hostname) {
    console.error("Usage: pnpm dlx tsx scripts/trigger-claim-demo.ts <hostname>");
    process.exit(1);
  }

  log("init", `Hostname: ${hostname}`);
  log("init", `Program:  ${PROGRAM_ID.toBase58()}`);
  log("init", `Backend:  ${BACKEND_URL}`);

  const phantom = loadKeypair(path.join(os.homedir(), ".config/solana/phantom-devnet.json"));
  const oracle = loadKeypair(path.resolve(__dirname, "../../backend/.secrets/oracle-keypair.json"));

  log("init", `Phantom:  ${phantom.publicKey.toBase58()}`);
  log("init", `Oracle:   ${oracle.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");

  // We use oracle as the Anchor provider wallet because the enable_insurance
  // tx is signed by the agent directly, and we never need the provider
  // wallet to sign anything; anchor just uses its pubkey for fee estimation.
  const wallet = new anchor.Wallet(oracle);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, "../target/idl/pact_insurance.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider);

  // --- Step 1: derive PDAs
  const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], PROGRAM_ID);
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(hostname)],
    PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    PROGRAM_ID,
  );

  log("pda", `Protocol: ${protocolPda.toBase58()}`);
  log("pda", `Pool:     ${poolPda.toBase58()}`);
  log("pda", `Vault:    ${vaultPda.toBase58()}`);

  const existingPool = await connection.getAccountInfo(poolPda);
  if (!existingPool) {
    console.error(
      `[FAIL] no pool exists for hostname="${hostname}" — run seed-devnet-pools.ts first`,
    );
    process.exit(1);
  }
  log("pool", "pool exists on-chain");

  // --- Step 2: load config to get usdcMint
  const config: any = await (program.account as any).protocolConfig.fetch(protocolPda);
  const usdcMint: PublicKey = config.usdcMint;
  log("pool", `config.usdcMint: ${usdcMint.toBase58()}`);

  const mintInfo = await getMint(connection, usdcMint);
  if (!mintInfo.mintAuthority || !mintInfo.mintAuthority.equals(phantom.publicKey)) {
    console.error(
      `[FAIL] phantom is not mint authority on config.usdcMint. ` +
        `Expected ${phantom.publicKey.toBase58()}, got ${mintInfo.mintAuthority?.toBase58() ?? "null"}`,
    );
    process.exit(1);
  }

  // --- Step 3: create fresh agent, fund SOL + mint test USDC
  const agent = Keypair.generate();
  log("agent", `fresh keypair: ${agent.publicKey.toBase58()}`);

  await fundSol(connection, phantom, agent.publicKey, 0.1 * LAMPORTS_PER_SOL);
  log("agent", "funded 0.1 SOL");

  const agentAta = await createAccount(connection, phantom, usdcMint, agent.publicKey);
  await mintToChecked(
    connection,
    phantom,
    usdcMint,
    agentAta,
    phantom,
    AGENT_INITIAL_USDC,
    6,
  );
  log("agent", `ATA: ${agentAta.toBase58()} with ${AGENT_INITIAL_USDC} raw USDC`);

  // --- Step 4: derive policy PDA
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  log("pda", `Policy:   ${policyPda.toBase58()}`);

  // --- Step 5: approve + enable_insurance atomically
  const approveIx = createApproveInstruction(
    agentAta,
    poolPda,
    agent.publicKey,
    ALLOWANCE_USDC,
  );
  // H-05: expires_at must be strictly in the future. 30 days out is plenty for a demo.
  const expiresAt = new BN(Math.floor(Date.now() / 1000) + 30 * 86400);
  const enableIx = await (program.methods as any)
    .enableInsurance({
      agentId: `demo-${Date.now().toString(36)}`,
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
  log("enable", `policy active (sig ${enableSig})`);

  // --- Step 6: provision a Pact API key via the admin HTTP endpoint.
  // Task 1's security hardening made agent_pubkey a server-side binding —
  // the backend reads it from api_keys, not from the record body. The
  // admin endpoint inserts the api_keys row with the correct binding.
  if (!ADMIN_TOKEN) {
    console.error(
      "[FAIL] ADMIN_TOKEN env var not set. Run with: ADMIN_TOKEN=<token> pnpm exec tsx ..."
    );
    process.exit(1);
  }
  const keyRes = await fetch(`${BACKEND_URL}/api/v1/admin/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({
      label: `demo-claim-${Date.now()}`,
      agent_pubkey: agent.publicKey.toBase58(),
    }),
  });
  if (!keyRes.ok) {
    console.error(`[FAIL] admin /keys: ${keyRes.status} ${await keyRes.text()}`);
    process.exit(1);
  }
  const { apiKey } = (await keyRes.json()) as { apiKey: string };
  log("auth", `provisioned api key ${apiKey.slice(0, 16)}... bound to ${agent.publicKey.toBase58()}`);

  // --- Step 8: POST a fake failed call record to the backend
  const callRecord = {
    hostname,
    endpoint: "/api/v3/simple/price",
    timestamp: new Date().toISOString(),
    status_code: 500,
    latency_ms: 250,
    classification: "error",
    payment_protocol: "x402",
    payment_amount: FAKE_PAYMENT_AMOUNT,
    payment_asset: "USDC",
    payment_network: "solana:devnet",
    payer_address: agent.publicKey.toBase58(),
    recipient_address: config.treasury.toBase58(),
    tx_hash: null,
    settlement_success: false,
    agent_pubkey: agent.publicKey.toBase58(),
  };

  // --- Step 8: snapshot pool state + agent balance BEFORE posting the
  // failure record. We verify the end-to-end settlement by reading on-chain
  // state before/after and checking the delta. No DB reads.
  const poolBefore: any = await (program.account as any).coveragePool.fetch(poolPda);
  const agentBalanceBefore = await getAccount(connection, agentAta);
  log(
    "pool.before",
    `total_claims_paid=${(Number(poolBefore.totalClaimsPaid) / 1e6).toFixed(4)} USDC`,
  );
  log("agent.before", `balance=${agentBalanceBefore.amount.toString()} raw USDC`);

  log("post", "POST /api/v1/records");
  const res = await fetch(`${BACKEND_URL}/api/v1/records`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ records: [callRecord] }),
  });
  const resBody = await res.json();
  log("post", `response: ${JSON.stringify(resBody)}`);
  if (!res.ok) {
    console.error("[FAIL] backend rejected records");
    process.exit(1);
  }

  // The backend's maybeCreateClaim runs inline during records.ts handling
  // but the records POST response returns before the on-chain tx confirms.
  // Give it a moment to finish the submit_claim.
  log("wait", "waiting 8s for on-chain claim settlement...");
  await new Promise((r) => setTimeout(r, 8000));

  // --- Step 9: re-read pool state + agent ATA balance on-chain. Diff both
  // against the snapshot to verify settlement. A successful refund shows up
  // as pool.total_claims_paid increasing AND agent.amount increasing by the
  // same amount (modulo aggregate cap / max_coverage_per_call).
  const poolAfter: any = await (program.account as any).coveragePool.fetch(poolPda);
  const agentBalanceAfter = await getAccount(connection, agentAta);
  const poolClaimsDelta =
    Number(poolAfter.totalClaimsPaid) - Number(poolBefore.totalClaimsPaid);
  const agentBalanceDelta =
    Number(agentBalanceAfter.amount) - Number(agentBalanceBefore.amount);

  log(
    "pool.after",
    `total_claims_paid=${(Number(poolAfter.totalClaimsPaid) / 1e6).toFixed(4)} USDC`,
  );
  log("agent.after", `balance=${agentBalanceAfter.amount.toString()} raw USDC`);
  log("delta", `pool.total_claims_paid: +${(poolClaimsDelta / 1e6).toFixed(4)} USDC`);
  log("delta", `agent.amount:           +${(agentBalanceDelta / 1e6).toFixed(4)} USDC`);

  if (poolClaimsDelta <= 0) {
    console.error("[FAIL] pool.total_claims_paid did not increase — claim never settled on-chain");
    process.exit(1);
  }
  if (agentBalanceDelta !== poolClaimsDelta) {
    console.error(
      `[FAIL] agent balance delta (${agentBalanceDelta}) != pool claims delta (${poolClaimsDelta})`,
    );
    process.exit(1);
  }

  console.log("\n=== DEMO_DONE ===");
  console.log(`DEMO_HOSTNAME=${hostname}`);
  console.log(`DEMO_AGENT_PUBKEY=${agent.publicKey.toBase58()}`);
  console.log(`DEMO_AGENT_ATA=${agentAta.toBase58()}`);
  console.log(`DEMO_POLICY_PDA=${policyPda.toBase58()}`);
  console.log(`DEMO_POOL_PDA=${poolPda.toBase58()}`);
  console.log(`DEMO_ENABLE_TX=${enableSig}`);
  console.log(`DEMO_ENABLE_EXPLORER=https://explorer.solana.com/tx/${enableSig}?cluster=devnet`);
  console.log(`DEMO_POOL_CLAIMS_DELTA_USDC=${(poolClaimsDelta / 1e6).toFixed(4)}`);
  console.log(`DEMO_AGENT_BALANCE_DELTA_USDC=${(agentBalanceDelta / 1e6).toFixed(4)}`);
  console.log(`DEMO_AGENT_FINAL_BALANCE=${agentBalanceAfter.amount.toString()}`);
  console.log("[verdict] REFUND LANDED ON-CHAIN");
  console.log("\nOpen the scorecard and go to /pool/" + encodeURIComponent(hostname));
  console.log("The pool detail page should now show 1 active policy + this refund in Recent Claims.");
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
