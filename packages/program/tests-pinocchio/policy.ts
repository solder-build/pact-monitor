// WP-12 / WP-13 migration target: policy.ts — enable_insurance +
// disable_policy handler tests.
//
// Covers:
//   1. rejects enable_insurance without prior SPL approve (DelegationMissing 6003)
//   2. enables insurance after SPL approve to pool PDA (happy path)
//   3. H-05: rejects enable_insurance with expires_at in past (PolicyExpired 6029)
//   Phase 5 F1 additions:
//   4. accepts referrer + share_bps=1000 and snapshots into Policy
//   5. rejects share_bps > 3000 (MAX_REFERRER_SHARE_BPS) — RateOutOfBounds 6027
//   6. rejects referrer_present=1 + share_bps=0 mutual-exclusion — InvalidRate 6014
//   WP-13 additions:
//   7. H-05: disable_policy sets active=false + decrements active_policies
//   8. disable_policy rejects from non-agent signer (Unauthorized 6018)
//
// Run with:
//   pnpm tsx tests-pinocchio/policy.ts

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
  appendTransactionMessageInstruction,
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
  getDisablePolicyInstruction,
  findProtocolConfigPda,
  findCoveragePoolPda,
  findCoveragePoolVaultPda,
  findPolicyPda,
  decodePolicy,
  decodeCoveragePool,
  getPolicyAgentId,
  PACT_INSURANCE_PROGRAM_ADDRESS,
} from '../../insurance/src/generated/index.js';

// ---------------------------------------------------------------------------
// Validator harness (mirrors tests-pinocchio/underwriter.ts)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRAM_ROOT = resolve(__dirname, '..');
const PINOCCHIO_SO = resolve(
  PROGRAM_ROOT,
  'target/deploy/pact_insurance_pinocchio.so',
);

const RPC_PORT = 9899 + Math.floor(Math.random() * 1000);
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
      `Pinocchio .so not found at ${PINOCCHIO_SO}. Run:\n  cargo build-sbf --manifest-path programs-pinocchio/pact-insurance-pinocchio/Cargo.toml --features bpf-entrypoint`,
    );
  }
  const ledger = await mkdtemp(resolve(tmpdir(), 'pact-pino-ledger-policy-'));
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
  proc.on('error', (err) => {
    console.error('validator spawn error:', err);
  });

  const endpoint = `http://127.0.0.1:${RPC_PORT}`;
  const rpc = createSolanaRpc(endpoint);
  const rpcSubscriptions = createSolanaRpcSubscriptions(
    `ws://127.0.0.1:${RPC_PORT + 1}`,
  );

  const started = Date.now();
  const timeoutMs = 60_000;
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await rpc.getHealth().send();
      if (health === 'ok') break;
    } catch (_) {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { proc, ledger, rpc, rpcSubscriptions, endpoint };
}

async function stopValidator(h: Harness): Promise<void> {
  h.proc.kill('SIGTERM');
  await new Promise<void>((resolveWait) => {
    h.proc.once('exit', () => resolveWait());
    setTimeout(() => {
      if (!h.proc.killed) h.proc.kill('SIGKILL');
      resolveWait();
    }, 5000);
  });
  await rm(h.ledger, { recursive: true, force: true });
}

async function waitForSignature(
  h: Harness,
  sig: string,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { value: statuses } = await h.rpc
      .getSignatureStatuses([sig as any])
      .send();
    const status = statuses[0];
    if (status) {
      if (status.err) {
        throw new Error(
          `transaction ${sig} failed: ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized'
      ) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`transaction ${sig} not confirmed within ${timeoutMs}ms`);
}

async function fundedSigner(h: Harness, sol = 10): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  const sig = await h.rpc
    .requestAirdrop(signer.address, BigInt(sol * 1_000_000_000) as any)
    .send();
  await waitForSignature(h, sig);
  return signer;
}

async function runCase(
  label: string,
  fn: () => Promise<void>,
  counter: { failures: number },
): Promise<void> {
  try {
    await fn();
    console.log(`[wp12] PASS: ${label}`);
  } catch (err) {
    counter.failures++;
    console.error(`[wp12] FAIL: ${label} —`, err);
  }
}

// ---------------------------------------------------------------------------
// SPL / web3 helpers
// ---------------------------------------------------------------------------

type MintFixture = {
  mint: Address;
  mintAuthority: Keypair;
  connection: Connection;
};

async function createUsdcMint(endpoint: string): Promise<MintFixture> {
  const connection = new Connection(endpoint, 'confirmed');
  const mintAuthority = Keypair.generate();
  const sig = await connection.requestAirdrop(
    mintAuthority.publicKey,
    2 * LAMPORTS_PER_SOL,
  );
  await connection.confirmTransaction(sig, 'confirmed');
  const mint = await createMint(
    connection,
    mintAuthority,
    mintAuthority.publicKey,
    null,
    6,
  );
  return { mint: address(mint.toBase58()), mintAuthority, connection };
}

async function createAgentAta(
  fixture: MintFixture,
  agentKp: Keypair,
  amountBase: bigint,
): Promise<Address> {
  const ata = await createAssociatedTokenAccount(
    fixture.connection,
    agentKp,
    new PublicKey(fixture.mint),
    agentKp.publicKey,
  );
  await mintTo(
    fixture.connection,
    fixture.mintAuthority,
    new PublicKey(fixture.mint),
    ata,
    fixture.mintAuthority.publicKey,
    amountBase,
  );
  return address(ata.toBase58());
}

async function kitSignerFromKeypair(kp: Keypair): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(kp.secretKey);
}

async function sendTx(
  h: Harness,
  payer: KeyPairSigner,
  ix: any,
): Promise<void> {
  const { value: latest } = await h.rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await h.rpc
    .sendTransaction(wire, {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send();
  await waitForSignature(h, sig);
}

/**
 * Convert a web3.js `TransactionInstruction` into a kit-shaped instruction so
 * we can combine SPL Approve (web3.js) with our Pinocchio `enable_insurance`
 * (kit) in a single transaction.
 */
function w3IxToKit(ix: TransactionInstruction): any {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey.toBase58()),
      role: k.isSigner
        ? k.isWritable
          ? 3 /* WRITABLE_SIGNER */
          : 2 /* READONLY_SIGNER */
        : k.isWritable
          ? 1 /* WRITABLE */
          : 0 /* READONLY */,
    })),
    data: new Uint8Array(ix.data),
  };
}

async function sendTxMany(
  h: Harness,
  payer: KeyPairSigner,
  ixs: any[],
): Promise<void> {
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
    .sendTransaction(wire, {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send();
  await waitForSignature(h, sig);
}

async function fetchAccountData(
  h: Harness,
  addr: Address,
): Promise<Uint8Array | null> {
  const { value: acct } = await h.rpc
    .getAccountInfo(addr, { encoding: 'base64' })
    .send();
  if (!acct) return null;
  return new Uint8Array(Buffer.from(acct.data[0], 'base64'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('[wp12] starting validator...');
  const h = await startValidator();
  const counter = { failures: 0 };
  try {
    const [protocolPda] = await findProtocolConfigPda();
    const deployer = await fundedSigner(h, 20);
    const authority = await fundedSigner(h, 10);
    const oracle = (await generateKeyPairSigner()).address;
    const treasury = (await generateKeyPairSigner()).address;

    const usdcFixture = await createUsdcMint(h.endpoint);

    // ---- bootstrap: initialize_protocol --------------------------------
    await sendTx(
      h,
      deployer,
      getInitializeProtocolInstruction({
        config: protocolPda,
        deployer,
        args: {
          authority: authority.address,
          oracle,
          treasury,
          usdcMint: usdcFixture.mint,
        },
      }),
    );

    // Each test uses its own pool+policy pair so the test cases stay
    // independent (policy PDA creation is single-shot per (pool, agent)).
    async function makePool(
      hostname: string,
    ): Promise<{ poolPda: Address; vaultPda: Address }> {
      const [poolPda] = await findCoveragePoolPda(hostname);
      const [vaultPda] = await findCoveragePoolVaultPda(poolPda);
      await sendTx(
        h,
        authority,
        getCreatePoolInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          poolUsdcMint: usdcFixture.mint,
          authority,
          args: {
            providerHostname: hostname,
            insuranceRateBps: null,
            maxCoveragePerCall: null,
          },
        }),
      );
      return { poolPda, vaultPda };
    }

    async function makeAgent(
      amountBase = 50_000_000n,
    ): Promise<{ kp: Keypair; signer: KeyPairSigner; ata: Address }> {
      const kp = Keypair.generate();
      const sig = await usdcFixture.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL,
      );
      await usdcFixture.connection.confirmTransaction(sig, 'confirmed');
      const signer = await kitSignerFromKeypair(kp);
      const ata = await createAgentAta(usdcFixture, kp, amountBase);
      return { kp, signer, ata };
    }

    const futureTs = (): bigint =>
      BigInt(Math.floor(Date.now() / 1000) + 86_400);

    // ---- Test 1 — rejects without SPL approve --------------------------
    await runCase(
      'rejects enable_insurance without prior SPL approve (DelegationMissing 6003)',
      async () => {
        const { poolPda } = await makePool('noapprove.example.com');
        const agent = await makeAgent();
        const [policyPda] = await findPolicyPda(poolPda, agent.signer.address);

        const expectedCode = 6003;
        const hex = expectedCode.toString(16);
        const pattern = new RegExp(`#${expectedCode}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(
            h,
            agent.signer,
            getEnableInsuranceInstruction({
              config: protocolPda,
              pool: poolPda,
              policy: policyPda,
              agentTokenAccount: agent.ata,
              agent: agent.signer,
              args: {
                agentId: 'agent-no-approve',
                expiresAt: futureTs(),
                referrer: new Uint8Array(32),
                referrerPresent: 0,
                referrerShareBps: 0,
              },
            }),
          );
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected DelegationMissing (${expectedCode}/0x${hex}), got: ${detail}`,
          );
        }
        assert(threw, 'enable_insurance must reject without delegation');
      },
      counter,
    );

    // ---- Test 2 — happy path after SPL approve -------------------------
    await runCase(
      'enables insurance after SPL approve to pool PDA',
      async () => {
        const hostname = 'happy.example.com';
        const { poolPda } = await makePool(hostname);
        const agent = await makeAgent();
        const [policyPda] = await findPolicyPda(poolPda, agent.signer.address);

        const approveIx = createApproveInstruction(
          new PublicKey(agent.ata),
          new PublicKey(poolPda),
          agent.kp.publicKey,
          10_000_000, // 10 USDC delegated
        );
        const enableIx = getEnableInsuranceInstruction({
          config: protocolPda,
          pool: poolPda,
          policy: policyPda,
          agentTokenAccount: agent.ata,
          agent: agent.signer,
          args: {
            agentId: 'agent-with-approve',
            expiresAt: futureTs(),
            referrer: new Uint8Array(32),
            referrerPresent: 0,
            referrerShareBps: 0,
          },
        });

        await sendTxMany(h, agent.signer, [w3IxToKit(approveIx), enableIx]);

        const raw = await fetchAccountData(h, policyPda);
        assert(raw, 'policy account exists');
        const policy = decodePolicy(raw);
        assert.equal(policy.discriminator, 3);
        assert.equal(policy.agent, agent.signer.address);
        assert.equal(policy.pool, poolPda);
        assert.equal(policy.agentTokenAccount, agent.ata);
        assert.equal(getPolicyAgentId(policy), 'agent-with-approve');
        assert.equal(policy.active, 1);
        assert.equal(policy.totalPremiumsPaid, 0n);
        assert.equal(policy.totalClaimsReceived, 0n);
        assert.equal(policy.callsCovered, 0n);
        assert.ok(policy.bump > 0);
        // F1 referrer fields default to None.
        assert.equal(policy.referrerPresent, 0);
        assert.equal(policy.referrerShareBps, 0);
        for (const b of policy.referrer) assert.equal(b, 0);
      },
      counter,
    );

    // ---- Test 3 — H-05: expires_at in past rejects --------------------
    await runCase(
      'H-05: rejects enable_insurance with expires_at in past (PolicyExpired 6029)',
      async () => {
        const { poolPda } = await makePool('expired.example.com');
        const agent = await makeAgent();
        const [policyPda] = await findPolicyPda(poolPda, agent.signer.address);

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
            agentId: 'expired-agent',
            expiresAt: 1n, // unix epoch +1s — definitely in the past
            referrer: new Uint8Array(32),
            referrerPresent: 0,
            referrerShareBps: 0,
          },
        });

        const expectedCode = 6029;
        const hex = expectedCode.toString(16);
        const pattern = new RegExp(`#${expectedCode}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTxMany(h, agent.signer, [w3IxToKit(approveIx), enableIx]);
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected PolicyExpired (${expectedCode}/0x${hex}), got: ${detail}`,
          );
        }
        assert(threw, 'expired policy must reject');
      },
      counter,
    );

    // ---- Phase 5 F1 Test 4 — referrer snapshot -------------------------
    await runCase(
      'F1: accepts referrer + share_bps=1000, snapshots into Policy',
      async () => {
        const { poolPda } = await makePool('f1-ref.example.com');
        const agent = await makeAgent();
        const [policyPda] = await findPolicyPda(poolPda, agent.signer.address);

        const approveIx = createApproveInstruction(
          new PublicKey(agent.ata),
          new PublicKey(poolPda),
          agent.kp.publicKey,
          10_000_000,
        );
        // Arbitrary 32-byte referrer — we only validate the bytes are
        // round-tripped, so a deterministic pattern is fine.
        const referrerBytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) referrerBytes[i] = i + 1;

        const enableIx = getEnableInsuranceInstruction({
          config: protocolPda,
          pool: poolPda,
          policy: policyPda,
          agentTokenAccount: agent.ata,
          agent: agent.signer,
          args: {
            agentId: 'agent-with-referrer',
            expiresAt: futureTs(),
            referrer: referrerBytes,
            referrerPresent: 1,
            referrerShareBps: 1000,
          },
        });

        await sendTxMany(h, agent.signer, [w3IxToKit(approveIx), enableIx]);

        const raw = await fetchAccountData(h, policyPda);
        assert(raw, 'policy exists');
        const policy = decodePolicy(raw);
        assert.equal(policy.referrerPresent, 1);
        assert.equal(policy.referrerShareBps, 1000);
        for (let i = 0; i < 32; i++) {
          assert.equal(
            policy.referrer[i],
            referrerBytes[i],
            `referrer byte ${i} snapshotted`,
          );
        }
      },
      counter,
    );

    // ---- F1 Test 5 — share_bps > 3000 rejects --------------------------
    await runCase(
      'F1: rejects share_bps > 3000 (RateOutOfBounds 6027)',
      async () => {
        const { poolPda } = await makePool('f1-over.example.com');
        const agent = await makeAgent();
        const [policyPda] = await findPolicyPda(poolPda, agent.signer.address);

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
            agentId: 'over-cap',
            expiresAt: futureTs(),
            referrer: new Uint8Array(32).fill(9),
            referrerPresent: 1,
            referrerShareBps: 3001,
          },
        });

        const expectedCode = 6027;
        const hex = expectedCode.toString(16);
        const pattern = new RegExp(`#${expectedCode}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTxMany(h, agent.signer, [w3IxToKit(approveIx), enableIx]);
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected RateOutOfBounds (${expectedCode}/0x${hex}), got: ${detail}`,
          );
        }
        assert(threw, 'share_bps > 3000 must reject');
      },
      counter,
    );

    // ---- WP-13 Test — H-05 disable_policy happy path ------------------
    await runCase(
      'H-05: disable_policy sets active=false + decrements active_policies',
      async () => {
        const hostname = 'disable-h05.example.com';
        const { poolPda } = await makePool(hostname);
        const agent = await makeAgent();
        const [policyPda] = await findPolicyPda(poolPda, agent.signer.address);

        // Enable first so we have an active policy to disable.
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
            agentId: 'agent-disable-h05',
            expiresAt: futureTs(),
            referrer: new Uint8Array(32),
            referrerPresent: 0,
            referrerShareBps: 0,
          },
        });
        await sendTxMany(h, agent.signer, [w3IxToKit(approveIx), enableIx]);

        // Snapshot pool.active_policies before disable.
        const poolRawBefore = await fetchAccountData(h, poolPda);
        assert(poolRawBefore, 'pool exists before disable');
        const poolBefore = decodeCoveragePool(poolRawBefore);
        assert.equal(poolBefore.activePolicies, 1);

        // Disable.
        const disableIx = getDisablePolicyInstruction({
          pool: poolPda,
          policy: policyPda,
          agent: agent.signer,
        });
        await sendTx(h, agent.signer, disableIx);

        // Policy.active flipped to 0.
        const policyRaw = await fetchAccountData(h, policyPda);
        assert(policyRaw, 'policy still exists after disable');
        const policy = decodePolicy(policyRaw);
        assert.equal(policy.active, 0, 'policy.active == 0 post-disable');

        // Pool.active_policies saturating-decremented by 1.
        const poolRawAfter = await fetchAccountData(h, poolPda);
        assert(poolRawAfter, 'pool exists after disable');
        const poolAfter = decodeCoveragePool(poolRawAfter);
        assert.equal(
          poolAfter.activePolicies,
          poolBefore.activePolicies - 1,
          'active_policies decremented by 1',
        );
      },
      counter,
    );

    // ---- WP-13 Test — reject disable_policy from non-agent signer ------
    await runCase(
      'disable_policy rejects from non-agent signer (Unauthorized 6018)',
      async () => {
        const hostname = 'disable-nonagent.example.com';
        const { poolPda } = await makePool(hostname);
        const agent = await makeAgent();
        const [policyPda] = await findPolicyPda(poolPda, agent.signer.address);

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
            agentId: 'agent-nonagent',
            expiresAt: futureTs(),
            referrer: new Uint8Array(32),
            referrerPresent: 0,
            referrerShareBps: 0,
          },
        });
        await sendTxMany(h, agent.signer, [w3IxToKit(approveIx), enableIx]);

        // Different signer attempts to disable.
        const attacker = await fundedSigner(h, 5);
        const disableIx = getDisablePolicyInstruction({
          pool: poolPda,
          policy: policyPda,
          agent: attacker,
        });

        const expectedCode = 6018;
        const hex = expectedCode.toString(16);
        const pattern = new RegExp(`#${expectedCode}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(h, attacker, disableIx);
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected Unauthorized (${expectedCode}/0x${hex}), got: ${detail}`,
          );
        }
        assert(threw, 'non-agent signer must be rejected');
      },
      counter,
    );

    // ---- F1 Test 6 — mutual-exclusion violation (present=1, share=0) ---
    await runCase(
      'F1: rejects referrer_present=1 + share_bps=0 mutual-exclusion (InvalidRate 6014)',
      async () => {
        const { poolPda } = await makePool('f1-mutex.example.com');
        const agent = await makeAgent();
        const [policyPda] = await findPolicyPda(poolPda, agent.signer.address);

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
            agentId: 'mutex-violation',
            expiresAt: futureTs(),
            referrer: new Uint8Array(32).fill(3),
            referrerPresent: 1,
            referrerShareBps: 0,
          },
        });

        const expectedCode = 6014;
        const hex = expectedCode.toString(16);
        const pattern = new RegExp(`#${expectedCode}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTxMany(h, agent.signer, [w3IxToKit(approveIx), enableIx]);
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected InvalidRate (${expectedCode}/0x${hex}), got: ${detail}`,
          );
        }
        assert(threw, 'mutex violation must reject');
      },
      counter,
    );
  } finally {
    console.log('[wp12] stopping validator...');
    await stopValidator(h);
  }

  if (counter.failures > 0) {
    console.error(`[wp12] ${counter.failures} test(s) failed`);
    process.exit(1);
  }
  console.log('[wp12] all migrated tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
