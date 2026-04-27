// WP-15 migration target: claims.ts — submit_claim handler tests.
//
// Covers:
//   Base claims.ts (3):
//     1. submits a claim and transfers refund (happy path)
//     2. rejects duplicate claim (same call_id) (DuplicateClaim 6013)
//     3. rejects claim outside window (old timestamp) (ClaimWindowExpired 6012)
//   security-hardening.ts (5):
//     4. C-03: rejects agent_token_account != policy.agent_token_account (6005)
//     5. H-02: accepts 36-char UUID-with-hyphens call_id
//     6. H-02: accepts 64-char (MAX_CALL_ID_LEN) call_id
//     7. H-05: rejects submit_claim against disabled policy (PolicyInactive 6006)
//     8. H-05: rejects submit_claim against expired policy (PolicyExpired 6029)
//
// Run with:
//   pnpm tsx tests-pinocchio/claims.ts
//
// Build prereq:
//   cargo build-sbf --manifest-path programs-pinocchio/pact-insurance-pinocchio/Cargo.toml --features bpf-entrypoint

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

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
  createAccount as splCreateAccount,
  createAssociatedTokenAccount,
  mintTo,
  createApproveInstruction,
  getAccount,
} from '@solana/spl-token';

import {
  getInitializeProtocolInstruction,
  getCreatePoolInstruction,
  getDepositInstruction,
  getEnableInsuranceInstruction,
  getDisablePolicyInstruction,
  getSubmitClaimInstruction,
  findProtocolConfigPda,
  findCoveragePoolPda,
  findCoveragePoolVaultPda,
  findUnderwriterPositionPda,
  findPolicyPda,
  findClaimPda,
  decodeClaim,
  decodeCoveragePool,
  decodePolicy,
  TriggerType,
  PACT_INSURANCE_PROGRAM_ADDRESS,
} from '../../insurance/src/generated/index.js';

// ---------------------------------------------------------------------------
// Validator harness (mirrors tests-pinocchio/settlement.ts)
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
  const ledger = await mkdtemp(resolve(tmpdir(), 'pact-pino-ledger-claims-'));
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
    console.log(`[wp15] PASS: ${label}`);
  } catch (err) {
    counter.failures++;
    console.error(`[wp15] FAIL: ${label} —`, err);
  }
}

async function kitSignerFromKeypair(kp: Keypair): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(kp.secretKey);
}

// ---------------------------------------------------------------------------
// SPL helpers
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

async function createTokenAccountForOwner(
  fixture: MintFixture,
  owner: PublicKey,
  mintOverride?: PublicKey,
): Promise<Address> {
  const mint = mintOverride ?? new PublicKey(fixture.mint);
  const ta = await splCreateAccount(
    fixture.connection,
    fixture.mintAuthority,
    mint,
    owner,
    Keypair.generate(),
  );
  return address(ta.toBase58());
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

function sha256(input: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('[wp15] starting validator...');
  const h = await startValidator();
  const counter = { failures: 0 };
  try {
    const [protocolPda] = await findProtocolConfigPda();
    const deployer = await fundedSigner(h, 20);
    const authority = await fundedSigner(h, 10);

    // Oracle MUST be a full keypair — submit_claim requires it to sign + be
    // writable (pays Claim PDA rent).
    const oracleKp = Keypair.generate();
    const oracleSigner = await kitSignerFromKeypair(oracleKp);
    {
      const sig = await h.rpc
        .requestAirdrop(oracleSigner.address, BigInt(10 * 1_000_000_000) as any)
        .send();
      await waitForSignature(h, sig);
    }

    const treasuryKp = Keypair.generate();
    const treasuryAddr = address(treasuryKp.publicKey.toBase58());

    const usdcFixture = await createUsdcMint(h.endpoint);

    // ---- bootstrap: initialize_protocol -----------------------------------
    await sendTx(
      h,
      deployer,
      getInitializeProtocolInstruction({
        config: protocolPda,
        deployer,
        args: {
          authority: authority.address,
          oracle: oracleSigner.address,
          treasury: treasuryAddr,
          usdcMint: usdcFixture.mint,
        },
      }),
    );

    // ---- factory: pool + funded underwriter + policy ----------------------
    async function makePoolWithUnderwriter(
      hostname: string,
      depositAmountBase: bigint = 100_000_000n, // 100 USDC
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

      // Fund the pool via an underwriter deposit so `total_available` > 0 and
      // the aggregate cap allows a refund.
      const underwriterKp = Keypair.generate();
      const uwAirdrop = await usdcFixture.connection.requestAirdrop(
        underwriterKp.publicKey,
        2 * LAMPORTS_PER_SOL,
      );
      await usdcFixture.connection.confirmTransaction(uwAirdrop, 'confirmed');
      const underwriterSigner = await kitSignerFromKeypair(underwriterKp);
      const underwriterAta = await createAssociatedTokenAccount(
        usdcFixture.connection,
        underwriterKp,
        new PublicKey(usdcFixture.mint),
        underwriterKp.publicKey,
      );
      await mintTo(
        usdcFixture.connection,
        usdcFixture.mintAuthority,
        new PublicKey(usdcFixture.mint),
        underwriterAta,
        usdcFixture.mintAuthority.publicKey,
        depositAmountBase,
      );
      const [positionPda] = await findUnderwriterPositionPda(
        poolPda,
        underwriterSigner.address,
      );
      await sendTx(
        h,
        underwriterSigner,
        getDepositInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          position: positionPda,
          underwriterTokenAccount: address(underwriterAta.toBase58()),
          underwriter: underwriterSigner,
          amount: depositAmountBase,
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

    async function enablePolicy(
      poolPda: Address,
      agent: { kp: Keypair; signer: KeyPairSigner; ata: Address },
      opts: {
        expiresAt?: bigint;
        approveAmount?: bigint;
        agentId?: string;
      } = {},
    ): Promise<Address> {
      const [policyPda] = await findPolicyPda(poolPda, agent.signer.address);
      const approveIx = createApproveInstruction(
        new PublicKey(agent.ata),
        new PublicKey(poolPda),
        agent.kp.publicKey,
        opts.approveAmount ?? 10_000_000n,
      );
      const enableIx = getEnableInsuranceInstruction({
        config: protocolPda,
        pool: poolPda,
        policy: policyPda,
        agentTokenAccount: agent.ata,
        agent: agent.signer,
        args: {
          agentId: opts.agentId ?? 'claim-agent',
          expiresAt: opts.expiresAt ?? futureTs(),
          referrer: new Uint8Array(32),
          referrerPresent: 0,
          referrerShareBps: 0,
        },
      });
      await sendTxMany(h, agent.signer, [w3IxToKit(approveIx), enableIx]);
      return policyPda;
    }

    async function expectReject(
      sendFn: () => Promise<void>,
      expected: number,
      label: string,
    ): Promise<void> {
      const hex = expected.toString(16);
      const pattern = new RegExp(`#${expected}\\b|0x${hex}\\b`, 'i');
      let threw = false;
      try {
        await sendFn();
      } catch (err) {
        threw = true;
        const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
        assert.match(
          detail,
          pattern,
          `${label}: expected ${expected}, got: ${detail}`,
        );
      }
      assert(threw, `${label}: must reject`);
    }

    // ---- Test 1 — happy path ----------------------------------------------
    await runCase(
      'submits a claim and transfers refund',
      async () => {
        const hostname = 'happy.claims.example.com';
        const { poolPda, vaultPda } = await makePoolWithUnderwriter(hostname);
        const agent = await makeAgent();
        const policyPda = await enablePolicy(poolPda, agent);

        const callId = 'call-abc-123';
        const callIdHash = sha256(callId);
        const [claimPda] = await findClaimPda(policyPda, callIdHash);

        const beforeAgent = await getAccount(
          usdcFixture.connection,
          new PublicKey(agent.ata),
        );
        const nowSecs = BigInt(Math.floor(Date.now() / 1000));

        const ix = getSubmitClaimInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          claim: claimPda,
          agentTokenAccount: agent.ata,
          oracle: oracleSigner,
          args: {
            callId,
            triggerType: TriggerType.Error,
            evidenceHash: new Uint8Array(32),
            callTimestamp: nowSecs - 30n,
            latencyMs: 1234,
            statusCode: 500,
            paymentAmount: 500_000n,
          },
        });
        await sendTx(h, oracleSigner, ix);

        const afterAgent = await getAccount(
          usdcFixture.connection,
          new PublicKey(agent.ata),
        );
        const delta = BigInt(afterAgent.amount) - BigInt(beforeAgent.amount);
        assert.equal(delta, 500_000n, 'agent ATA credited with refund');

        const claimRaw = await fetchAccountData(h, claimPda);
        assert(claimRaw, 'claim PDA exists after submit');
        const claim = decodeClaim(claimRaw);
        assert.equal(claim.refundAmount, 500_000n, 'claim.refund_amount');
        assert.equal(claim.paymentAmount, 500_000n, 'claim.payment_amount');
        assert.equal(claim.status, 1 /* Approved */, 'status=Approved');
        assert.equal(claim.triggerType, 1 /* Error */, 'trigger=Error');
        // Claim.call_id stores the sha256 digest (WP-4 addendum #9).
        const storedCallId = new Uint8Array(claim.callId);
        assert.deepEqual(
          storedCallId,
          callIdHash,
          'claim.call_id stores sha256(callId)',
        );

        const poolRaw = await fetchAccountData(h, poolPda);
        assert(poolRaw);
        const pool = decodeCoveragePool(poolRaw);
        assert.equal(pool.totalClaimsPaid, 500_000n, 'pool.total_claims_paid');
        assert.equal(pool.payoutsThisWindow, 500_000n, 'pool.payouts_this_window');

        const policyRaw = await fetchAccountData(h, policyPda);
        assert(policyRaw);
        const policy = decodePolicy(policyRaw);
        assert.equal(policy.totalClaimsReceived, 500_000n);
        assert.equal(policy.callsCovered, 1n);
      },
      counter,
    );

    // ---- Test 2 — duplicate claim rejection -------------------------------
    await runCase(
      'rejects duplicate claim (same call_id) — DuplicateClaim 6013 OR system 0x0',
      async () => {
        const hostname = 'dup.claims.example.com';
        const { poolPda, vaultPda } = await makePoolWithUnderwriter(hostname);
        const agent = await makeAgent();
        const policyPda = await enablePolicy(poolPda, agent);

        const callId = 'dup-call-xyz';
        const callIdHash = sha256(callId);
        const [claimPda] = await findClaimPda(policyPda, callIdHash);

        const now = BigInt(Math.floor(Date.now() / 1000));

        // First claim — succeeds.
        await sendTx(
          h,
          oracleSigner,
          getSubmitClaimInstruction({
            config: protocolPda,
            pool: poolPda,
            vault: vaultPda,
            policy: policyPda,
            claim: claimPda,
            agentTokenAccount: agent.ata,
            oracle: oracleSigner,
            args: {
              callId,
              triggerType: TriggerType.Error,
              evidenceHash: new Uint8Array(32),
              callTimestamp: now - 30n,
              latencyMs: 100,
              statusCode: 500,
              paymentAmount: 500_000n,
            },
          }),
        );

        // Second claim with identical call_id — same PDA, CreateAccount will
        // fail with `AccountAlreadyInitialized` (system 0x0) OR our explicit
        // DuplicateClaim (6013). Accept either signal — the property under
        // test is "duplicate is rejected", not the specific error code.
        let threw = false;
        try {
          await sendTx(
            h,
            oracleSigner,
            getSubmitClaimInstruction({
              config: protocolPda,
              pool: poolPda,
              vault: vaultPda,
              policy: policyPda,
              claim: claimPda,
              agentTokenAccount: agent.ata,
              oracle: oracleSigner,
              args: {
                callId,
                triggerType: TriggerType.Error,
                evidenceHash: new Uint8Array(32),
                callTimestamp: now - 10n,
                latencyMs: 100,
                statusCode: 500,
                paymentAmount: 500_000n,
              },
            }),
          );
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          // Either our 6013 (if the handler got to the is_data_empty check
          // first) or the system "already in use" error from CreateAccount.
          assert.match(
            detail,
            /#6013\b|0x17dd\b|already in use|AccountAlreadyInitialized/i,
            `duplicate claim must reject, got: ${detail}`,
          );
        }
        assert(threw, 'duplicate claim must reject');
      },
      counter,
    );

    // ---- Test 3 — stale callTimestamp -------------------------------------
    await runCase(
      'rejects claim outside window (old timestamp) — ClaimWindowExpired 6012',
      async () => {
        const hostname = 'stale.claims.example.com';
        const { poolPda, vaultPda } = await makePoolWithUnderwriter(hostname);
        const agent = await makeAgent();
        const policyPda = await enablePolicy(poolPda, agent);

        const callId = 'too-old-call';
        const callIdHash = sha256(callId);
        const [claimPda] = await findClaimPda(policyPda, callIdHash);

        const now = BigInt(Math.floor(Date.now() / 1000));
        await expectReject(
          async () => {
            await sendTx(
              h,
              oracleSigner,
              getSubmitClaimInstruction({
                config: protocolPda,
                pool: poolPda,
                vault: vaultPda,
                policy: policyPda,
                claim: claimPda,
                agentTokenAccount: agent.ata,
                oracle: oracleSigner,
                args: {
                  callId,
                  triggerType: TriggerType.Error,
                  evidenceHash: new Uint8Array(32),
                  callTimestamp: now - 7200n, // 2h ago, > 1h default window
                  latencyMs: 100,
                  statusCode: 500,
                  paymentAmount: 500_000n,
                },
              }),
            );
          },
          6012,
          'stale callTimestamp',
        );
      },
      counter,
    );

    // ---- Test 4 — C-03 wrong agent ATA ------------------------------------
    await runCase(
      'C-03: rejects agent_token_account != policy.agent_token_account (TokenAccountMismatch 6005)',
      async () => {
        const hostname = 'c03.claims.example.com';
        const { poolPda, vaultPda } = await makePoolWithUnderwriter(hostname);
        const agent = await makeAgent();
        const policyPda = await enablePolicy(poolPda, agent);

        // Create a SECOND ATA owned by the same agent on the same mint but at
        // a different address. mint/owner pass; key equality must reject.
        const wrongAta = await createTokenAccountForOwner(
          usdcFixture,
          agent.kp.publicKey,
        );

        const callId = 'c03-call';
        const callIdHash = sha256(callId);
        const [claimPda] = await findClaimPda(policyPda, callIdHash);
        const now = BigInt(Math.floor(Date.now() / 1000));

        await expectReject(
          async () => {
            await sendTx(
              h,
              oracleSigner,
              getSubmitClaimInstruction({
                config: protocolPda,
                pool: poolPda,
                vault: vaultPda,
                policy: policyPda,
                claim: claimPda,
                agentTokenAccount: wrongAta,
                oracle: oracleSigner,
                args: {
                  callId,
                  triggerType: TriggerType.Error,
                  evidenceHash: new Uint8Array(32),
                  callTimestamp: now - 30n,
                  latencyMs: 100,
                  statusCode: 500,
                  paymentAmount: 500_000n,
                },
              }),
            );
          },
          6005,
          'wrong agent ATA',
        );
      },
      counter,
    );

    // ---- Test 5 — H-02 36-char UUID --------------------------------------
    await runCase(
      'H-02: accepts 36-char UUID-with-hyphens call_id',
      async () => {
        const hostname = 'h02-uuid.claims.example.com';
        const { poolPda, vaultPda } = await makePoolWithUnderwriter(hostname);
        const agent = await makeAgent();
        const policyPda = await enablePolicy(poolPda, agent);

        const callId = '11111111-2222-3333-4444-555555555555';
        assert.equal(callId.length, 36, 'UUID is 36 chars');
        const callIdHash = sha256(callId);
        const [claimPda] = await findClaimPda(policyPda, callIdHash);

        const now = BigInt(Math.floor(Date.now() / 1000));
        await sendTx(
          h,
          oracleSigner,
          getSubmitClaimInstruction({
            config: protocolPda,
            pool: poolPda,
            vault: vaultPda,
            policy: policyPda,
            claim: claimPda,
            agentTokenAccount: agent.ata,
            oracle: oracleSigner,
            args: {
              callId,
              triggerType: TriggerType.Error,
              evidenceHash: new Uint8Array(32),
              callTimestamp: now - 10n,
              latencyMs: 100,
              statusCode: 500,
              paymentAmount: 100_000n,
            },
          }),
        );

        const claimRaw = await fetchAccountData(h, claimPda);
        assert(claimRaw);
        const claim = decodeClaim(claimRaw);
        const storedCallId = new Uint8Array(claim.callId);
        assert.deepEqual(
          storedCallId,
          callIdHash,
          'UUID hash stored as claim.call_id',
        );
      },
      counter,
    );

    // ---- Test 6 — H-02 64-char call_id -----------------------------------
    await runCase(
      'H-02: accepts 64-char call_id (MAX_CALL_ID_LEN)',
      async () => {
        const hostname = 'h02-max.claims.example.com';
        const { poolPda, vaultPda } = await makePoolWithUnderwriter(hostname);
        const agent = await makeAgent();
        const policyPda = await enablePolicy(poolPda, agent);

        const callId = 'a'.repeat(64);
        assert.equal(callId.length, 64, 'call_id is exactly 64 chars');
        const callIdHash = sha256(callId);
        const [claimPda] = await findClaimPda(policyPda, callIdHash);

        const now = BigInt(Math.floor(Date.now() / 1000));
        await sendTx(
          h,
          oracleSigner,
          getSubmitClaimInstruction({
            config: protocolPda,
            pool: poolPda,
            vault: vaultPda,
            policy: policyPda,
            claim: claimPda,
            agentTokenAccount: agent.ata,
            oracle: oracleSigner,
            args: {
              callId,
              triggerType: TriggerType.Error,
              evidenceHash: new Uint8Array(32),
              callTimestamp: now - 10n,
              latencyMs: 100,
              statusCode: 500,
              paymentAmount: 100_000n,
            },
          }),
        );

        const claimRaw = await fetchAccountData(h, claimPda);
        assert(claimRaw);
        const claim = decodeClaim(claimRaw);
        const storedCallId = new Uint8Array(claim.callId);
        assert.deepEqual(
          storedCallId,
          callIdHash,
          '64-char call_id hashed + stored',
        );
      },
      counter,
    );

    // ---- Test 7 — H-05 disabled policy ------------------------------------
    await runCase(
      'H-05: rejects submit_claim against disabled policy (PolicyInactive 6006)',
      async () => {
        const hostname = 'h05-disabled.claims.example.com';
        const { poolPda, vaultPda } = await makePoolWithUnderwriter(hostname);
        const agent = await makeAgent();
        const policyPda = await enablePolicy(poolPda, agent);

        // Disable the policy.
        await sendTx(
          h,
          agent.signer,
          getDisablePolicyInstruction({
            pool: poolPda,
            policy: policyPda,
            agent: agent.signer,
          }),
        );

        const callId = 'disabled-call';
        const callIdHash = sha256(callId);
        const [claimPda] = await findClaimPda(policyPda, callIdHash);
        const now = BigInt(Math.floor(Date.now() / 1000));

        await expectReject(
          async () => {
            await sendTx(
              h,
              oracleSigner,
              getSubmitClaimInstruction({
                config: protocolPda,
                pool: poolPda,
                vault: vaultPda,
                policy: policyPda,
                claim: claimPda,
                agentTokenAccount: agent.ata,
                oracle: oracleSigner,
                args: {
                  callId,
                  triggerType: TriggerType.Error,
                  evidenceHash: new Uint8Array(32),
                  callTimestamp: now - 10n,
                  latencyMs: 100,
                  statusCode: 500,
                  paymentAmount: 500_000n,
                },
              }),
            );
          },
          6006,
          'disabled policy',
        );
      },
      counter,
    );

    // ---- Test 8 — H-05 expired policy -------------------------------------
    await runCase(
      'H-05: rejects submit_claim against expired policy (PolicyExpired 6029)',
      async () => {
        const hostname = 'h05-expired.claims.example.com';
        const { poolPda, vaultPda } = await makePoolWithUnderwriter(hostname);
        const agent = await makeAgent();

        // expires_at ~ now + 2s so we can sleep past it.
        const shortExpires = BigInt(Math.floor(Date.now() / 1000) + 2);
        const policyPda = await enablePolicy(poolPda, agent, {
          expiresAt: shortExpires,
        });

        await new Promise((r) => setTimeout(r, 4_000));

        const callId = 'expired-call';
        const callIdHash = sha256(callId);
        const [claimPda] = await findClaimPda(policyPda, callIdHash);
        const now = BigInt(Math.floor(Date.now() / 1000));

        await expectReject(
          async () => {
            await sendTx(
              h,
              oracleSigner,
              getSubmitClaimInstruction({
                config: protocolPda,
                pool: poolPda,
                vault: vaultPda,
                policy: policyPda,
                claim: claimPda,
                agentTokenAccount: agent.ata,
                oracle: oracleSigner,
                args: {
                  callId,
                  triggerType: TriggerType.Error,
                  evidenceHash: new Uint8Array(32),
                  callTimestamp: now - 5n,
                  latencyMs: 100,
                  statusCode: 500,
                  paymentAmount: 500_000n,
                },
              }),
            );
          },
          6029,
          'expired policy',
        );
      },
      counter,
    );
  } finally {
    console.log('[wp15] stopping validator...');
    await stopValidator(h);
  }

  if (counter.failures > 0) {
    console.error(`[wp15] ${counter.failures} test(s) failed`);
    process.exit(1);
  }
  console.log('[wp15] all migrated tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
