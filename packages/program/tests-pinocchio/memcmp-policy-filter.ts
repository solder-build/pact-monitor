// WP-18: memcmp offset=8 integration test.
//
// Validates Convention #16 from the port-plan post-mortem:
//   Policy on-disk layout: disc(1) + pad(7) + agent(32) + pool(32) + ...
//   - agent at byte offset 8   → memcmp(offset:8,  bytes:<agentBase58>)
//   - pool  at byte offset 40  → memcmp(offset:40, bytes:<poolBase58>)
//
// The test:
//   1. Initializes protocol, creates two independent pools (A and B).
//   2. Creates two agents, each with a policy on pool A.
//   3. Creates one agent with a policy on pool B.
//   4. Uses getProgramAccounts with memcmp(offset:8)  to filter by agent.
//   5. Uses getProgramAccounts with memcmp(offset:40) to filter by pool.
//   6. Asserts correct subsets in both cases.
//
// Run with:
//   pnpm tsx tests-pinocchio/memcmp-policy-filter.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  appendTransactionMessageInstructions,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  createApproveInstruction,
} from '@solana/spl-token';

import {
  getInitializeProtocolInstruction,
  getCreatePoolInstruction,
  getEnableInsuranceInstruction,
  findProtocolConfigPda,
  findCoveragePoolPda,
  findCoveragePoolVaultPda,
  findPolicyPda,
  decodePolicy,
  PACT_INSURANCE_PROGRAM_ADDRESS,
  POLICY_DISCRIMINATOR,
} from '../../insurance/src/generated/index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRAM_ROOT = resolve(__dirname, '..');
const PINOCCHIO_SO = resolve(
  PROGRAM_ROOT,
  'target/deploy/pact_insurance_pinocchio.so',
);

const RPC_PORT = 10899 + Math.floor(Math.random() * 500);
const FAUCET_PORT = RPC_PORT + 2;

interface Harness {
  proc: ChildProcess;
  ledger: string;
  rpc: any;
  rpcSubscriptions: any;
  endpoint: string;
}

async function startValidator(): Promise<Harness> {
  if (!existsSync(PINOCCHIO_SO)) {
    throw new Error(
      `Pinocchio .so not found at ${PINOCCHIO_SO}.\n` +
        `Run: cargo build-sbf --manifest-path programs-pinocchio/pact-insurance-pinocchio/Cargo.toml --features bpf-entrypoint`,
    );
  }
  const ledger = await mkdtemp(resolve(tmpdir(), 'pact-pino-memcmp-'));
  const proc = spawn(
    'solana-test-validator',
    [
      '--ledger', ledger,
      '--reset',
      '--quiet',
      '--rpc-port', String(RPC_PORT),
      '--faucet-port', String(FAUCET_PORT),
      '--bpf-program', PACT_INSURANCE_PROGRAM_ADDRESS, PINOCCHIO_SO,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.on('error', (err) => console.error('validator spawn error:', err));

  const endpoint = `http://127.0.0.1:${RPC_PORT}`;
  const rpc = createSolanaRpc(endpoint);
  const rpcSubscriptions = createSolanaRpcSubscriptions(
    `ws://127.0.0.1:${RPC_PORT + 1}`,
  );

  const started = Date.now();
  while (Date.now() - started < 60_000) {
    try {
      if ((await rpc.getHealth().send()) === 'ok') break;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return { proc, ledger, rpc, rpcSubscriptions, endpoint };
}

async function stopValidator(h: Harness): Promise<void> {
  h.proc.kill('SIGTERM');
  await new Promise<void>((res) => {
    h.proc.once('exit', () => res());
    setTimeout(() => { if (!h.proc.killed) h.proc.kill('SIGKILL'); res(); }, 5000);
  });
  await rm(h.ledger, { recursive: true, force: true });
}

async function waitForSig(h: Harness, sig: string, ms = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const { value: st } = await h.rpc.getSignatureStatuses([sig as any]).send();
    const s = st[0];
    if (s) {
      if (s.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.err)}`);
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`tx ${sig} not confirmed in ${ms}ms`);
}

async function fundedSigner(h: Harness, sol = 10): Promise<KeyPairSigner> {
  const s = await generateKeyPairSigner();
  const sig = await h.rpc.requestAirdrop(s.address, BigInt(sol * 1_000_000_000) as any).send();
  await waitForSig(h, sig);
  return s;
}

async function sendTxMany(h: Harness, payer: KeyPairSigner, ixs: any[]): Promise<void> {
  const { value: latest } = await h.rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await h.rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();
  await waitForSig(h, sig);
}

function w3IxToKit(ix: TransactionInstruction): any {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey.toBase58()),
      role: k.isSigner ? (k.isWritable ? 3 : 2) : k.isWritable ? 1 : 0,
    })),
    data: new Uint8Array(ix.data),
  };
}

type MintFixture = { mint: Address; mintAuthority: Keypair; connection: Connection };

async function setupMint(endpoint: string): Promise<MintFixture> {
  const connection = new Connection(endpoint, 'confirmed');
  const mintAuthority = Keypair.generate();
  const sig = await connection.requestAirdrop(mintAuthority.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, 'confirmed');
  const mint = await createMint(connection, mintAuthority, mintAuthority.publicKey, null, 6);
  return { mint: address(mint.toBase58()), mintAuthority, connection };
}

async function makeAgentWithAta(
  mf: MintFixture,
  amount = 50_000_000n,
): Promise<{ kp: Keypair; signer: KeyPairSigner; ata: Address }> {
  const kp = Keypair.generate();
  const sig = await mf.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
  await mf.connection.confirmTransaction(sig, 'confirmed');
  const ata = await createAssociatedTokenAccount(
    mf.connection, kp, new PublicKey(mf.mint), kp.publicKey,
  );
  await mintTo(mf.connection, mf.mintAuthority, new PublicKey(mf.mint), ata, mf.mintAuthority.publicKey, amount);
  const signer = await createKeyPairSignerFromBytes(kp.secretKey);
  return { kp, signer, ata: address(ata.toBase58()) };
}

// Enable insurance for (agent, pool). Returns the policy PDA address.
async function enablePolicy(
  h: Harness,
  mf: MintFixture,
  agent: { kp: Keypair; signer: KeyPairSigner; ata: Address },
  poolPda: Address,
  protocolPda: Address,
): Promise<Address> {
  const [policyPda] = await findPolicyPda(poolPda, agent.signer.address);

  // SPL approve: delegate allowance to pool PDA
  const approveIx = createApproveInstruction(
    new PublicKey(agent.ata),
    new PublicKey(poolPda),
    agent.kp.publicKey,
    10_000_000,
  );

  const enableIx = getEnableInsuranceInstruction({
    config: protocolPda,
    pool: poolPda,
    policy: policyPda,
    agentTokenAccount: agent.ata,
    agent: agent.signer,
    args: {
      agentId: agent.kp.publicKey.toBase58().slice(0, 16),
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
      referrer: new Uint8Array(32),
      referrerPresent: 0,
      referrerShareBps: 0,
    },
  });

  await sendTxMany(h, agent.signer, [w3IxToKit(approveIx), enableIx]);
  return policyPda;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('[wp18-memcmp] starting validator...');
  const h = await startValidator();
  let failures = 0;

  try {
    const [protocolPda] = await findProtocolConfigPda();
    const deployer = await fundedSigner(h, 20);
    const authority = await fundedSigner(h, 10);
    const oracle = (await generateKeyPairSigner()).address;
    const treasury = (await generateKeyPairSigner()).address;
    const mf = await setupMint(h.endpoint);

    // Initialize protocol
    await sendTxMany(h, deployer, [
      getInitializeProtocolInstruction({
        config: protocolPda,
        deployer,
        args: { authority: authority.address, oracle, treasury, usdcMint: mf.mint },
      }),
    ]);

    // Create pool A and pool B
    const [poolA] = await findCoveragePoolPda('provider-a.example.com');
    const [vaultA] = await findCoveragePoolVaultPda(poolA);
    const [poolB] = await findCoveragePoolPda('provider-b.example.com');
    const [vaultB] = await findCoveragePoolVaultPda(poolB);

    await sendTxMany(h, authority, [
      getCreatePoolInstruction({
        config: protocolPda,
        pool: poolA,
        vault: vaultA,
        poolUsdcMint: mf.mint,
        authority,
        args: { providerHostname: 'provider-a.example.com', insuranceRateBps: null, maxCoveragePerCall: null },
      }),
    ]);
    await sendTxMany(h, authority, [
      getCreatePoolInstruction({
        config: protocolPda,
        pool: poolB,
        vault: vaultB,
        poolUsdcMint: mf.mint,
        authority,
        args: { providerHostname: 'provider-b.example.com', insuranceRateBps: null, maxCoveragePerCall: null },
      }),
    ]);

    // Create 2 agents on pool A, 1 agent on pool B
    const agentA1 = await makeAgentWithAta(mf);
    const agentA2 = await makeAgentWithAta(mf);
    const agentB1 = await makeAgentWithAta(mf);

    const policyA1 = await enablePolicy(h, mf, agentA1, poolA, protocolPda);
    const policyA2 = await enablePolicy(h, mf, agentA2, poolA, protocolPda);
    const policyB1 = await enablePolicy(h, mf, agentB1, poolB, protocolPda);

    console.log('[wp18-memcmp] policies created. policyA1=%s policyA2=%s policyB1=%s', policyA1, policyA2, policyB1);

    // -----------------------------------------------------------------------
    // Test 1: filter by agent at offset=8.
    // Querying for agentA1 should return exactly policyA1.
    // -----------------------------------------------------------------------
    try {
      const byAgent = await h.rpc.getProgramAccounts(
        PACT_INSURANCE_PROGRAM_ADDRESS,
        {
          encoding: 'base64',
          filters: [
            { memcmp: { offset: 8, bytes: agentA1.signer.address, encoding: 'base58' } },
          ],
        },
      ).send() as Array<{ pubkey: string; account: { data: [string, string] } }>;

      assert.equal(byAgent.length, 1, `expected 1 policy for agentA1, got ${byAgent.length}`);
      assert.equal(
        String(byAgent[0].pubkey),
        String(policyA1),
        `filter by agent offset=8: expected policyA1`,
      );

      // Decode and verify the agent field
      const bytes = new Uint8Array(Buffer.from(byAgent[0].account.data[0], 'base64'));
      const policy = decodePolicy(bytes);
      assert.equal(
        String(policy.agent),
        String(agentA1.signer.address),
        'decoded policy.agent must match filter key',
      );
      assert.equal(policy.discriminator, POLICY_DISCRIMINATOR, 'discriminator must be POLICY_DISCRIMINATOR=3');

      console.log('[wp18-memcmp] PASS: memcmp offset=8 (agent) returns exactly 1 policy for agentA1');
    } catch (err) {
      failures++;
      console.error('[wp18-memcmp] FAIL: memcmp offset=8 (agent) test —', err);
    }

    // -----------------------------------------------------------------------
    // Test 2: filter by pool at offset=40 (=8+32, after disc+pad+agent).
    // Querying for poolA should return policyA1 + policyA2 but NOT policyB1.
    // -----------------------------------------------------------------------
    try {
      const byPool = await h.rpc.getProgramAccounts(
        PACT_INSURANCE_PROGRAM_ADDRESS,
        {
          encoding: 'base64',
          filters: [
            { memcmp: { offset: 40, bytes: poolA, encoding: 'base58' } },
          ],
        },
      ).send() as Array<{ pubkey: string; account: { data: [string, string] } }>;

      const poolAKeys = new Set(byPool.map((a) => String(a.pubkey)));
      assert.equal(byPool.length, 2, `expected 2 policies for poolA, got ${byPool.length}`);
      assert.ok(poolAKeys.has(String(policyA1)), 'policyA1 must be in pool A results');
      assert.ok(poolAKeys.has(String(policyA2)), 'policyA2 must be in pool A results');
      assert.ok(!poolAKeys.has(String(policyB1)), 'policyB1 must NOT appear in pool A results');

      // Verify each decoded policy has pool === poolA
      for (const acct of byPool) {
        const bytes = new Uint8Array(Buffer.from(acct.account.data[0], 'base64'));
        const p = decodePolicy(bytes);
        assert.equal(String(p.pool), String(poolA), `policy ${acct.pubkey} has wrong pool`);
      }

      console.log('[wp18-memcmp] PASS: memcmp offset=40 (pool) returns exactly 2 policies for poolA');
    } catch (err) {
      failures++;
      console.error('[wp18-memcmp] FAIL: memcmp offset=40 (pool) test —', err);
    }

    // -----------------------------------------------------------------------
    // Test 3: filter by poolB — must return only policyB1.
    // -----------------------------------------------------------------------
    try {
      const byPoolB = await h.rpc.getProgramAccounts(
        PACT_INSURANCE_PROGRAM_ADDRESS,
        {
          encoding: 'base64',
          filters: [
            { memcmp: { offset: 40, bytes: poolB, encoding: 'base58' } },
          ],
        },
      ).send() as Array<{ pubkey: string; account: { data: [string, string] } }>;

      assert.equal(byPoolB.length, 1, `expected 1 policy for poolB, got ${byPoolB.length}`);
      assert.equal(String(byPoolB[0].pubkey), String(policyB1), 'only policyB1 must match poolB');

      console.log('[wp18-memcmp] PASS: memcmp offset=40 (pool) returns exactly 1 policy for poolB');
    } catch (err) {
      failures++;
      console.error('[wp18-memcmp] FAIL: memcmp offset=40 (pool) test for poolB —', err);
    }

  } finally {
    console.log('[wp18-memcmp] stopping validator...');
    await stopValidator(h);
  }

  if (failures > 0) {
    console.error(`[wp18-memcmp] ${failures} test(s) FAILED`);
    process.exit(1);
  }
  console.log('[wp18-memcmp] all tests PASSED');
}

run().catch((err) => {
  console.error('[wp18-memcmp] fatal error:', err);
  process.exit(1);
});
