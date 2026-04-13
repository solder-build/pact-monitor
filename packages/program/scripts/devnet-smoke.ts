/**
 * Phase F + G devnet end-to-end smoke script.
 *
 * Self-contained script that exercises the full Phase 3 pipeline against
 * devnet and doubles as the seed/sim deliverable for Phase G.
 *
 * Usage (from packages/program/):
 *   pnpm dlx tsx scripts/devnet-smoke.ts
 *   pnpm dlx tsx scripts/devnet-smoke.ts --reuse-mint <mintPubkey>
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { PactInsurance } from "../target/types/pact_insurance";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintToChecked,
  createApproveInstruction,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DEVNET_RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob");
const USDC_DECIMALS = 6;

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function logStep(n: number, desc: string): void {
  console.log(`\n[STEP ${n}] ${desc}...`);
}

function logOk(msg: string): void {
  console.log(`  [OK] ${msg}`);
}

function logInfo(msg: string): void {
  console.log(`  ${msg}`);
}

function failStep(stepName: string, err: unknown): never {
  console.error(`\n[FAIL] ${stepName}`);
  if (err instanceof Error) {
    console.error(`  ${err.message}`);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(`  ${String(err)}`);
  }
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadKeypair(p: string): Keypair {
  const resolved = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function parseArgs(): { reuseMint?: PublicKey } {
  const argv = process.argv.slice(2);
  const out: { reuseMint?: PublicKey } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reuse-mint" && argv[i + 1]) {
      out.reuseMint = new PublicKey(argv[i + 1]);
      i++;
    }
  }
  return out;
}

async function airdropWithRetry(
  connection: Connection,
  pubkey: PublicKey,
  lamports: number,
  label: string
): Promise<void> {
  try {
    const sig = await connection.requestAirdrop(pubkey, lamports);
    await connection.confirmTransaction(sig, "confirmed");
    return;
  } catch (err) {
    logInfo(`  first airdrop for ${label} failed, retrying once after 2s...`);
    await sleep(2000);
    try {
      const sig = await connection.requestAirdrop(pubkey, lamports);
      await connection.confirmTransaction(sig, "confirmed");
      return;
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(
        `airdrop for ${label} exhausted retries (devnet rate-limit?). last error: ${msg}`
      );
    }
  }
}

/**
 * Fund an ephemeral keypair with SOL from the phantom funding account.
 * On devnet the public airdrop faucet is aggressively rate-limited, so we
 * prefer direct transfers from a pre-funded wallet.
 */
async function fundFromPhantom(
  connection: Connection,
  phantom: Keypair,
  recipient: PublicKey,
  lamports: number,
  label: string
): Promise<void> {
  const ix = SystemProgram.transfer({
    fromPubkey: phantom.publicKey,
    toPubkey: recipient,
    lamports,
  });
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: phantom.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(ix);
  tx.sign(phantom);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  logInfo(`  transferred ${lamports / LAMPORTS_PER_SOL} SOL to ${label} (tx ${sig})`);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  // ---------------------------------------------------------------------------
  // Load keypairs
  // ---------------------------------------------------------------------------
  const oracleKeypairPath = path.resolve(
    __dirname,
    "../../backend/.secrets/oracle-keypair.json"
  );
  const phantomKeypairPath = path.join(
    os.homedir(),
    ".config/solana/phantom-devnet.json"
  );

  const oracle = loadKeypair(oracleKeypairPath);
  const phantom = loadKeypair(phantomKeypairPath);
  const underwriter = Keypair.generate();
  const agent = Keypair.generate();

  // ---------------------------------------------------------------------------
  // Connection + program
  // ---------------------------------------------------------------------------
  const connection = new Connection(DEVNET_RPC, "confirmed");
  const wallet = new anchor.Wallet(phantom);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, "../target/idl/pact_insurance.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program<PactInsurance>(idl, provider);

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  // ---------------------------------------------------------------------------
  // State header
  // ---------------------------------------------------------------------------
  const initialConfig = await (program.account as any).protocolConfig.fetch(
    protocolPda
  );

  console.log("=".repeat(78));
  console.log("Pact Network devnet smoke test");
  console.log("=".repeat(78));
  console.log(`Program ID:      ${program.programId.toString()}`);
  console.log(`Protocol PDA:    ${protocolPda.toString()}`);
  console.log(`Oracle:          ${oracle.publicKey.toString()}`);
  console.log(`Phantom:         ${phantom.publicKey.toString()}`);
  console.log(`Underwriter:     ${underwriter.publicKey.toString()} (ephemeral)`);
  console.log(`Agent:           ${agent.publicKey.toString()} (ephemeral)`);
  console.log(`Current usdcMint (on-chain): ${initialConfig.usdcMint.toString()}`);
  console.log(`Current protocolFeeBps:      ${initialConfig.protocolFeeBps}`);
  console.log(`Current authority:           ${initialConfig.authority.toString()}`);
  console.log(`Current treasury:            ${initialConfig.treasury.toString()}`);
  console.log("=".repeat(78));

  if (initialConfig.authority.toString() !== oracle.publicKey.toString()) {
    console.error(
      `[FAIL] on-chain authority (${initialConfig.authority.toString()}) != oracle keypair (${oracle.publicKey.toString()})`
    );
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // STEP 1: Create or reuse test mint
  // ---------------------------------------------------------------------------
  logStep(1, "Create or reuse test mint");
  let testMint: PublicKey;
  try {
    if (args.reuseMint) {
      testMint = args.reuseMint;
      logOk(`reusing mint ${testMint.toString()}`);
    } else {
      testMint = await createMint(
        connection,
        phantom, // payer
        phantom.publicKey, // mint authority
        null, // freeze authority
        USDC_DECIMALS
      );
      logOk(`created mint ${testMint.toString()}`);
      logInfo(`  re-run with: --reuse-mint ${testMint.toString()}`);
    }
  } catch (err) {
    failStep("Step 1: Create test mint", err);
  }
  await sleep(500);

  // ---------------------------------------------------------------------------
  // STEP 2: Update protocol config to use test mint (if needed)
  // ---------------------------------------------------------------------------
  logStep(2, "Update protocol config to use test mint");
  try {
    if (initialConfig.usdcMint.toString() === testMint!.toString()) {
      logOk("config.usdcMint already matches test mint, skipping update");
    } else {
      const sig = await (program.methods as any)
        .updateConfig({
          protocolFeeBps: null,
          minPoolDeposit: null,
          defaultInsuranceRateBps: null,
          defaultMaxCoveragePerCall: null,
          minPremiumBps: null,
          withdrawalCooldownSeconds: null,
          aggregateCapBps: null,
          aggregateCapWindowSeconds: null,
          claimWindowSeconds: null,
          maxClaimsPerBatch: null,
          paused: null,
          treasury: null,
          usdcMint: testMint!,
        })
        .accounts({
          config: protocolPda,
          authority: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();
      await connection.confirmTransaction(sig, "confirmed");
      logOk(`update_config tx ${sig}`);
      logInfo(
        `  https://explorer.solana.com/tx/${sig}?cluster=devnet`
      );
    }
  } catch (err) {
    failStep("Step 2: update_config", err);
  }
  await sleep(500);

  // Re-read config (for treasury + protocolFeeBps + usdcMint)
  const config = await (program.account as any).protocolConfig.fetch(protocolPda);
  const treasuryPubkey: PublicKey = config.treasury;
  const protocolFeeBps: number = config.protocolFeeBps;
  logInfo(`  config.usdcMint now: ${config.usdcMint.toString()}`);
  logInfo(`  config.treasury:     ${treasuryPubkey.toString()}`);
  logInfo(`  config.protocolFeeBps: ${protocolFeeBps}`);

  // ---------------------------------------------------------------------------
  // STEP 3: Fund underwriter, agent, and oracle with SOL
  // ---------------------------------------------------------------------------
  // The devnet public faucet is aggressively rate-limited. Prefer direct
  // transfers from the phantom wallet (pre-funded with ~9 SOL). The oracle
  // also needs SOL because it is a writable signer for create_pool and
  // submit_claim, both of which init new accounts paid by the authority.
  logStep(3, "Fund ephemeral underwriter/agent and the oracle with SOL");
  try {
    const phantomBalance = await connection.getBalance(phantom.publicKey);
    logInfo(`  phantom balance: ${phantomBalance / LAMPORTS_PER_SOL} SOL`);
    const oracleBalance = await connection.getBalance(oracle.publicKey);
    logInfo(`  oracle balance:  ${oracleBalance / LAMPORTS_PER_SOL} SOL`);

    if (phantomBalance >= 0.6 * LAMPORTS_PER_SOL) {
      await fundFromPhantom(
        connection,
        phantom,
        underwriter.publicKey,
        0.1 * LAMPORTS_PER_SOL,
        "underwriter"
      );
      await fundFromPhantom(
        connection,
        phantom,
        agent.publicKey,
        0.1 * LAMPORTS_PER_SOL,
        "agent"
      );
      // Top up oracle if it's nearly empty (it's the writable signer for
      // create_pool, submit_claim, etc., so it pays rent for new accounts).
      if (oracleBalance < 0.1 * LAMPORTS_PER_SOL) {
        await fundFromPhantom(
          connection,
          phantom,
          oracle.publicKey,
          0.2 * LAMPORTS_PER_SOL,
          "oracle"
        );
      }
      logOk(`funded ephemeral keypairs (and oracle if needed) from phantom`);
    } else {
      logInfo(`  phantom balance too low, falling back to airdrop`);
      await airdropWithRetry(
        connection,
        underwriter.publicKey,
        2 * LAMPORTS_PER_SOL,
        "underwriter"
      );
      logOk(`airdropped 2 SOL to underwriter`);
      await sleep(500);
      await airdropWithRetry(
        connection,
        agent.publicKey,
        2 * LAMPORTS_PER_SOL,
        "agent"
      );
      logOk(`airdropped 2 SOL to agent`);
      if (oracleBalance < 0.1 * LAMPORTS_PER_SOL) {
        await sleep(500);
        await airdropWithRetry(
          connection,
          oracle.publicKey,
          1 * LAMPORTS_PER_SOL,
          "oracle"
        );
        logOk(`airdropped 1 SOL to oracle`);
      }
    }
  } catch (err) {
    failStep("Step 3: Fund SOL", err);
  }
  await sleep(500);

  // ---------------------------------------------------------------------------
  // STEP 4: Create test pool
  // ---------------------------------------------------------------------------
  logStep(4, "Create test pool for unique hostname");
  // Keep hostname under 32 bytes (the max seed length). Base36 timestamp
  // suffix keeps it short while still being unique per run.
  const hostname = `smk-${Date.now().toString(36)}.test`;
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(hostname)],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    program.programId
  );
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
        usdcMint: testMint!,
        authority: oracle.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([oracle])
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
    logOk(`hostname=${hostname}`);
    logOk(`pool PDA=${poolPda.toString()}`);
    logOk(`vault PDA=${vaultPda.toString()}`);
    logInfo(`  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  } catch (err) {
    failStep("Step 4: create_pool", err);
  }
  await sleep(500);

  // ---------------------------------------------------------------------------
  // STEP 5: Underwriter deposits 100 USDC
  // ---------------------------------------------------------------------------
  logStep(5, "Underwriter mints and deposits 100 USDC");
  const [positionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      poolPda.toBuffer(),
      underwriter.publicKey.toBuffer(),
    ],
    program.programId
  );
  let underwriterAta: PublicKey;
  try {
    underwriterAta = await createAssociatedTokenAccount(
      connection,
      phantom, // payer
      testMint!,
      underwriter.publicKey
    );
    logOk(`created underwriter ATA ${underwriterAta.toString()}`);

    await mintToChecked(
      connection,
      phantom, // payer
      testMint!,
      underwriterAta,
      phantom, // mint authority
      100_000_000,
      USDC_DECIMALS
    );
    logOk(`minted 100 USDC to underwriter ATA`);

    const sig = await (program.methods as any)
      .deposit(new BN(100_000_000))
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
    await connection.confirmTransaction(sig, "confirmed");
    logOk(`deposit tx ${sig}`);

    const pool = await (program.account as any).coveragePool.fetch(poolPda);
    const vault = await getAccount(connection, vaultPda);
    if (pool.totalDeposited.toNumber() !== 100_000_000) {
      throw new Error(
        `pool.totalDeposited=${pool.totalDeposited.toNumber()} != 100_000_000`
      );
    }
    if (Number(vault.amount) !== 100_000_000) {
      throw new Error(
        `vault.amount=${vault.amount} != 100_000_000`
      );
    }
    logOk(`pool.totalDeposited=${pool.totalDeposited.toNumber()} (100 USDC)`);
    logOk(`vault.amount=${vault.amount} (100 USDC)`);
  } catch (err) {
    failStep("Step 5: Underwriter deposit", err);
  }
  await sleep(500);

  // ---------------------------------------------------------------------------
  // STEP 6: Agent enables insurance with 10 USDC delegation
  // ---------------------------------------------------------------------------
  logStep(6, "Agent mints USDC, approves, and enables insurance");
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), poolPda.toBuffer(), agent.publicKey.toBuffer()],
    program.programId
  );
  let agentAta: PublicKey;
  try {
    agentAta = await createAssociatedTokenAccount(
      connection,
      phantom, // payer
      testMint!,
      agent.publicKey
    );
    logOk(`created agent ATA ${agentAta.toString()}`);

    await mintToChecked(
      connection,
      phantom,
      testMint!,
      agentAta,
      phantom,
      50_000_000,
      USDC_DECIMALS
    );
    logOk(`minted 50 USDC to agent ATA`);

    const approveIx = createApproveInstruction(
      agentAta,
      poolPda,
      agent.publicKey,
      10_000_000
    );
    const enableIx = await (program.methods as any)
      .enableInsurance({
        agentId: "smoke-agent",
        expiresAt: new BN(0),
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

    const tx = new Transaction().add(approveIx).add(enableIx);
    const sig = await provider.sendAndConfirm(tx, [agent]);
    logOk(`approve + enable_insurance tx ${sig}`);
    logInfo(`  https://explorer.solana.com/tx/${sig}?cluster=devnet`);

    const policy = await (program.account as any).policy.fetch(policyPda);
    const agentAccount = await getAccount(connection, agentAta);

    if (!policy.active) throw new Error("policy.active should be true");
    if (policy.agentTokenAccount.toString() !== agentAta.toString()) {
      throw new Error(
        `policy.agentTokenAccount=${policy.agentTokenAccount.toString()} != ${agentAta.toString()}`
      );
    }
    if (Number(agentAccount.amount) !== 50_000_000) {
      throw new Error(
        `agent balance=${agentAccount.amount} != 50_000_000 (should be unchanged)`
      );
    }
    if (Number(agentAccount.delegatedAmount) !== 10_000_000) {
      throw new Error(
        `agent delegatedAmount=${agentAccount.delegatedAmount} != 10_000_000`
      );
    }
    logOk(`policy.active=true`);
    logOk(`agent balance=${agentAccount.amount} (50 USDC, unchanged)`);
    logOk(`agent delegatedAmount=${agentAccount.delegatedAmount} (10 USDC)`);
  } catch (err) {
    failStep("Step 6: enable_insurance", err);
  }
  await sleep(500);

  // ---------------------------------------------------------------------------
  // STEP 7: Settle premium for a 4 USDC call value
  // ---------------------------------------------------------------------------
  logStep(7, "Settle premium (4 USDC call value)");
  let treasuryAta: PublicKey;
  try {
    treasuryAta = getAssociatedTokenAddressSync(testMint!, treasuryPubkey);
    const treasuryInfo = await connection.getAccountInfo(treasuryAta);
    if (!treasuryInfo) {
      // Create the ATA for the treasury (phantom is both payer and owner here)
      await createAssociatedTokenAccount(
        connection,
        phantom, // payer
        testMint!,
        treasuryPubkey // owner
      );
      logOk(`created treasury ATA ${treasuryAta.toString()}`);
    } else {
      logOk(`treasury ATA exists ${treasuryAta.toString()}`);
    }

    const beforeAgent = await getAccount(connection, agentAta!);
    const beforeVault = await getAccount(connection, vaultPda);
    const beforeTreasury = await getAccount(connection, treasuryAta);

    const pool = await (program.account as any).coveragePool.fetch(poolPda);
    const insuranceRateBps: number = pool.insuranceRateBps;
    const callValue = 4_000_000;
    const expectedGross = Math.floor((callValue * insuranceRateBps) / 10_000);
    const expectedProtocolFee = Math.floor(
      (expectedGross * protocolFeeBps) / 10_000
    );
    const expectedPoolPremium = expectedGross - expectedProtocolFee;
    logInfo(
      `  insuranceRateBps=${insuranceRateBps}, gross=${expectedGross}, protocolFee=${expectedProtocolFee}, poolPremium=${expectedPoolPremium}`
    );

    const sig = await (program.methods as any)
      .settlePremium(new BN(callValue))
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: policyPda,
        agentTokenAccount: agentAta!,
        treasuryTokenAccount: treasuryAta,
        authority: oracle.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([oracle])
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
    logOk(`settle_premium tx ${sig}`);
    logInfo(`  https://explorer.solana.com/tx/${sig}?cluster=devnet`);

    const afterAgent = await getAccount(connection, agentAta!);
    const afterVault = await getAccount(connection, vaultPda);
    const afterTreasury = await getAccount(connection, treasuryAta);

    const agentDelta = Number(beforeAgent.amount) - Number(afterAgent.amount);
    const vaultDelta = Number(afterVault.amount) - Number(beforeVault.amount);
    const treasuryDelta =
      Number(afterTreasury.amount) - Number(beforeTreasury.amount);
    if (agentDelta !== expectedGross) {
      throw new Error(`agentDelta=${agentDelta} != ${expectedGross}`);
    }
    if (vaultDelta !== expectedPoolPremium) {
      throw new Error(`vaultDelta=${vaultDelta} != ${expectedPoolPremium}`);
    }
    if (treasuryDelta !== expectedProtocolFee) {
      throw new Error(`treasuryDelta=${treasuryDelta} != ${expectedProtocolFee}`);
    }
    logOk(`agent paid ${agentDelta}, vault +${vaultDelta}, treasury +${treasuryDelta}`);
  } catch (err) {
    failStep("Step 7: settle_premium", err);
  }
  await sleep(500);

  // ---------------------------------------------------------------------------
  // STEP 8: Submit a claim for a fake call failure
  // ---------------------------------------------------------------------------
  logStep(8, "Submit claim for failed call");
  const callId = "smoke-call-001";
  const [claimPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), policyPda.toBuffer(), Buffer.from(callId)],
    program.programId
  );
  let claimSig = "";
  try {
    const beforeAgent = await getAccount(connection, agentAta!);
    const now = Math.floor(Date.now() / 1000);
    const paymentAmount = 500_000;

    claimSig = await (program.methods as any)
      .submitClaim({
        callId,
        triggerType: { error: {} },
        evidenceHash: Array(32).fill(7),
        callTimestamp: new BN(now),
        latencyMs: 500,
        statusCode: 500,
        paymentAmount: new BN(paymentAmount),
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        policy: policyPda,
        claim: claimPda,
        agentTokenAccount: agentAta!,
        authority: oracle.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();
    await connection.confirmTransaction(claimSig, "confirmed");
    logOk(`submit_claim tx ${claimSig}`);
    logInfo(`  https://explorer.solana.com/tx/${claimSig}?cluster=devnet`);

    const afterAgent = await getAccount(connection, agentAta!);
    const refund = Number(afterAgent.amount) - Number(beforeAgent.amount);
    if (refund !== paymentAmount) {
      throw new Error(`refund=${refund} != ${paymentAmount}`);
    }
    logOk(`agent received refund of ${refund} (0.5 USDC)`);

    const claim = await (program.account as any).claim.fetch(claimPda);
    logOk(`claim.refundAmount=${claim.refundAmount.toNumber()}`);
    logOk(`claim.callId=${claim.callId}`);
  } catch (err) {
    failStep("Step 8: submit_claim", err);
  }

  // ---------------------------------------------------------------------------
  // Final summary
  // ---------------------------------------------------------------------------
  const finalPool = await (program.account as any).coveragePool.fetch(poolPda);
  const finalPolicy = await (program.account as any).policy.fetch(policyPda);
  const finalAgent = await getAccount(connection, agentAta!);

  console.log("\n" + "=".repeat(78));
  console.log("SMOKE TEST SUMMARY (greppable)");
  console.log("=".repeat(78));
  console.log(`SMOKE_PROGRAM_ID=${program.programId.toString()}`);
  console.log(`SMOKE_PROTOCOL_PDA=${protocolPda.toString()}`);
  console.log(`SMOKE_TEST_MINT=${testMint!.toString()}`);
  console.log(`SMOKE_HOSTNAME=${hostname}`);
  console.log(`SMOKE_POOL_PDA=${poolPda.toString()}`);
  console.log(`SMOKE_VAULT_PDA=${vaultPda.toString()}`);
  console.log(`SMOKE_POSITION_PDA=${positionPda.toString()}`);
  console.log(`SMOKE_POLICY_PDA=${policyPda.toString()}`);
  console.log(`SMOKE_CLAIM_PDA=${claimPda.toString()}`);
  console.log(`SMOKE_UNDERWRITER_PUBKEY=${underwriter.publicKey.toString()}`);
  console.log(`SMOKE_AGENT_PUBKEY=${agent.publicKey.toString()}`);
  console.log(`SMOKE_POOL_TOTAL_DEPOSITED=${finalPool.totalDeposited.toString()}`);
  console.log(`SMOKE_POOL_TOTAL_AVAILABLE=${finalPool.totalAvailable.toString()}`);
  console.log(
    `SMOKE_POOL_TOTAL_PREMIUMS_EARNED=${finalPool.totalPremiumsEarned.toString()}`
  );
  console.log(`SMOKE_POOL_TOTAL_CLAIMS_PAID=${finalPool.totalClaimsPaid.toString()}`);
  console.log(`SMOKE_POOL_ACTIVE_POLICIES=${finalPool.activePolicies}`);
  console.log(`SMOKE_POLICY_ACTIVE=${finalPolicy.active}`);
  console.log(
    `SMOKE_POLICY_TOTAL_PREMIUMS_PAID=${finalPolicy.totalPremiumsPaid.toString()}`
  );
  console.log(
    `SMOKE_POLICY_TOTAL_CLAIMS_RECEIVED=${finalPolicy.totalClaimsReceived.toString()}`
  );
  console.log(`SMOKE_POLICY_CALLS_COVERED=${finalPolicy.callsCovered.toString()}`);
  console.log(`SMOKE_AGENT_FINAL_BALANCE=${finalAgent.amount.toString()}`);
  console.log(
    `SMOKE_AGENT_DELEGATED_AMOUNT=${finalAgent.delegatedAmount.toString()}`
  );
  console.log(`SMOKE_CLAIM_TX=${claimSig}`);
  console.log(
    `SMOKE_CLAIM_EXPLORER=https://explorer.solana.com/tx/${claimSig}?cluster=devnet`
  );
  console.log(
    `SMOKE_PROGRAM_EXPLORER=https://explorer.solana.com/address/${program.programId.toString()}?cluster=devnet`
  );
  console.log("=".repeat(78));
  console.log("\n[OK] smoke test completed successfully");
}

main().catch((err) => {
  console.error("\n[FATAL] uncaught error:");
  console.error(err);
  process.exit(1);
});
