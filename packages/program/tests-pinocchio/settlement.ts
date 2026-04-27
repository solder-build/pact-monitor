// WP-14 migration target: settlement.ts — settle_premium handler tests.
//
// Covers:
//   1. base: settles premium by pulling from agent ATA (2-way split, referrer=0)
//   2. base: rejects when oracle signer is wrong (UnauthorizedOracle 6025)
//   3. H-05: settle_premium STILL collects on disabled policy (premium-evasion guard)
//   4. H-05: rejects settle_premium when policy expired (PolicyExpired 6029)
//   5. F1: three-way split for policy with referrer
//   6. F1: rejects when referrer_present==1 but remaining_accounts empty (6005)
//   7. F1: rejects when referrer ATA has wrong owner (6005)
//   8. F1: rejects when referrer ATA has wrong mint (6005)
//
// Run with:
//   pnpm tsx tests-pinocchio/settlement.ts

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
  createAccount as splCreateAccount,
  createAssociatedTokenAccount,
  mintTo,
  createApproveInstruction,
  getAccount,
} from '@solana/spl-token';

import {
  getInitializeProtocolInstruction,
  getCreatePoolInstruction,
  getEnableInsuranceInstruction,
  getDisablePolicyInstruction,
  getSettlePremiumInstruction,
  findProtocolConfigPda,
  findCoveragePoolPda,
  findCoveragePoolVaultPda,
  findPolicyPda,
  decodePolicy,
  decodeCoveragePool,
  PACT_INSURANCE_PROGRAM_ADDRESS,
} from '../../insurance/src/generated/index.js';

// ---------------------------------------------------------------------------
// Validator harness (mirrors tests-pinocchio/policy.ts)
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
  const ledger = await mkdtemp(resolve(tmpdir(), 'pact-pino-ledger-settle-'));
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
    console.log(`[wp14] PASS: ${label}`);
  } catch (err) {
    counter.failures++;
    console.error(`[wp14] FAIL: ${label} —`, err);
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
  console.log('[wp14] starting validator...');
  const h = await startValidator();
  const counter = { failures: 0 };
  try {
    const [protocolPda] = await findProtocolConfigPda();
    const deployer = await fundedSigner(h, 20);
    const authority = await fundedSigner(h, 10);

    // Oracle MUST be a full keypair — settle_premium requires it to sign.
    const oracleKp = Keypair.generate();
    const oracleSigner = await kitSignerFromKeypair(oracleKp);
    {
      const sig = await h.rpc
        .requestAirdrop(oracleSigner.address, BigInt(5 * 1_000_000_000) as any)
        .send();
      await waitForSignature(h, sig);
    }

    // Treasury is a normal pubkey; its ATA is owned by it, payer is deployer.
    const treasuryKp = Keypair.generate();
    const treasuryAddr = address(treasuryKp.publicKey.toBase58());

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
          oracle: oracleSigner.address,
          treasury: treasuryAddr,
          usdcMint: usdcFixture.mint,
        },
      }),
    );

    const treasuryAta = await createTokenAccountForOwner(
      usdcFixture,
      treasuryKp.publicKey,
    );

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

    async function enablePolicy(
      poolPda: Address,
      agent: { kp: Keypair; signer: KeyPairSigner; ata: Address },
      opts: {
        expiresAt?: bigint;
        referrer?: Uint8Array;
        referrerPresent?: number;
        referrerShareBps?: number;
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
          agentId: opts.agentId ?? 'settle-agent',
          expiresAt: opts.expiresAt ?? futureTs(),
          referrer: opts.referrer ?? new Uint8Array(32),
          referrerPresent: opts.referrerPresent ?? 0,
          referrerShareBps: opts.referrerShareBps ?? 0,
        },
      });
      await sendTxMany(h, agent.signer, [w3IxToKit(approveIx), enableIx]);
      return policyPda;
    }

    // ---- Test 1 — base happy path (2-way split) -----------------------
    await runCase(
      'settles premium by pulling from agent ATA (2-way split)',
      async () => {
        const hostname = 'base.settle.example.com';
        const { poolPda, vaultPda } = await makePool(hostname);
        const agent = await makeAgent();
        const policyPda = await enablePolicy(poolPda, agent);

        // Read protocol fee live (earlier tests may have mutated config).
        const cfgRaw = await fetchAccountData(h, protocolPda);
        assert(cfgRaw);
        // Offset: ProtocolConfig — protocolFeeBps at byte offset ? Use decoder.
        // Fallback: compute from observed delta after settle.
        const callValue = 4_000_000n;

        const beforeAgent = await getAccount(
          usdcFixture.connection,
          new PublicKey(agent.ata),
        );
        const beforeVault = await getAccount(
          usdcFixture.connection,
          new PublicKey(vaultPda),
        );
        const beforeTreasury = await getAccount(
          usdcFixture.connection,
          new PublicKey(treasuryAta),
        );

        const ix = getSettlePremiumInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          treasuryAta,
          agentAta: agent.ata,
          oracleSigner,
          callValue,
        });
        await sendTx(h, oracleSigner, ix);

        const afterAgent = await getAccount(
          usdcFixture.connection,
          new PublicKey(agent.ata),
        );
        const afterVault = await getAccount(
          usdcFixture.connection,
          new PublicKey(vaultPda),
        );
        const afterTreasury = await getAccount(
          usdcFixture.connection,
          new PublicKey(treasuryAta),
        );

        // pool rate default = 25 bps, so gross = 4_000_000 * 25 / 10_000 = 10_000.
        const gross = 10_000n;
        const spent = BigInt(beforeAgent.amount) - BigInt(afterAgent.amount);
        assert.equal(spent, gross, 'agent spent gross premium');

        const received =
          BigInt(afterVault.amount) -
          BigInt(beforeVault.amount) +
          (BigInt(afterTreasury.amount) - BigInt(beforeTreasury.amount));
        assert.equal(received, gross, 'pool+treasury receipts == gross');

        // Pool_cut + treasury_cut must both be nonzero (fee default 1500 bps).
        const treasuryCut =
          BigInt(afterTreasury.amount) - BigInt(beforeTreasury.amount);
        const poolCut = BigInt(afterVault.amount) - BigInt(beforeVault.amount);
        assert(treasuryCut > 0n, 'treasury received a cut');
        assert(poolCut > 0n, 'vault received a cut');

        // Policy + pool accumulators.
        const policyRaw = await fetchAccountData(h, policyPda);
        assert(policyRaw);
        const policy = decodePolicy(policyRaw);
        assert.equal(policy.totalPremiumsPaid, gross);

        const poolRaw = await fetchAccountData(h, poolPda);
        assert(poolRaw);
        const pool = decodeCoveragePool(poolRaw);
        assert.equal(pool.totalPremiumsEarned, poolCut);
        assert.equal(pool.totalAvailable, poolCut);
      },
      counter,
    );

    // ---- Test 2 — wrong oracle signer -------------------------------
    await runCase(
      'rejects settle_premium when oracle signer is wrong (UnauthorizedOracle 6025)',
      async () => {
        const hostname = 'badoracle.settle.example.com';
        const { poolPda, vaultPda } = await makePool(hostname);
        const agent = await makeAgent();
        const policyPda = await enablePolicy(poolPda, agent);

        const rando = await fundedSigner(h, 2);

        const ix = getSettlePremiumInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          treasuryAta,
          agentAta: agent.ata,
          oracleSigner: rando,
          callValue: 1_000_000n,
        });

        const expected = 6025;
        const hex = expected.toString(16);
        const pattern = new RegExp(`#${expected}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(h, rando, ix);
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected UnauthorizedOracle (${expected}), got: ${detail}`,
          );
        }
        assert(threw, 'wrong oracle must reject');
      },
      counter,
    );

    // ---- Test 3 — H-05 premium-evasion: disabled policy still collects
    await runCase(
      'H-05: settle_premium STILL collects on disabled policy (premium-evasion guard)',
      async () => {
        const hostname = 'h05-disabled.settle.example.com';
        const { poolPda, vaultPda } = await makePool(hostname);
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

        // Settle still works — policy.active == 0 is NOT a gate.
        const beforeAgent = await getAccount(
          usdcFixture.connection,
          new PublicKey(agent.ata),
        );

        const ix = getSettlePremiumInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          treasuryAta,
          agentAta: agent.ata,
          oracleSigner,
          callValue: 4_000_000n,
        });
        await sendTx(h, oracleSigner, ix);

        const afterAgent = await getAccount(
          usdcFixture.connection,
          new PublicKey(agent.ata),
        );
        const spent = BigInt(beforeAgent.amount) - BigInt(afterAgent.amount);
        assert.equal(spent, 10_000n, 'premium still collected post-disable');

        const policyRaw = await fetchAccountData(h, policyPda);
        assert(policyRaw);
        const policy = decodePolicy(policyRaw);
        assert.equal(
          policy.active,
          0,
          'policy still marked inactive — settle did NOT flip it',
        );
      },
      counter,
    );

    // ---- Test 4 — H-05 expired policy rejects -----------------------
    await runCase(
      'H-05: rejects settle_premium when policy expired (PolicyExpired 6029)',
      async () => {
        const hostname = 'h05-expired.settle.example.com';
        const { poolPda, vaultPda } = await makePool(hostname);
        const agent = await makeAgent();

        // expires_at ~ now + 2s so we can sleep past it.
        const shortExpires = BigInt(Math.floor(Date.now() / 1000) + 2);
        const policyPda = await enablePolicy(poolPda, agent, {
          expiresAt: shortExpires,
        });

        // Wait for on-chain clock to pass expires_at (validator clock may drift;
        // sleep 4s to be safe).
        await new Promise((r) => setTimeout(r, 4_000));

        const ix = getSettlePremiumInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          treasuryAta,
          agentAta: agent.ata,
          oracleSigner,
          callValue: 1_000_000n,
        });

        const expected = 6029;
        const hex = expected.toString(16);
        const pattern = new RegExp(`#${expected}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(h, oracleSigner, ix);
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected PolicyExpired (${expected}), got: ${detail}`,
          );
        }
        assert(threw, 'expired policy must reject');
      },
      counter,
    );

    // ---- F1 Test 5 — three-way split -------------------------------
    await runCase(
      'F1: three-way split for policy with referrer',
      async () => {
        const hostname = 'f1-3way.settle.example.com';
        const { poolPda, vaultPda } = await makePool(hostname);
        const agent = await makeAgent();

        // Referrer: separate keypair w/ USDC ATA.
        const referrerKp = Keypair.generate();
        const sig = await usdcFixture.connection.requestAirdrop(
          referrerKp.publicKey,
          1 * LAMPORTS_PER_SOL,
        );
        await usdcFixture.connection.confirmTransaction(sig, 'confirmed');
        const referrerAta = await createTokenAccountForOwner(
          usdcFixture,
          referrerKp.publicKey,
        );
        const referrerBytes = new Uint8Array(referrerKp.publicKey.toBytes());

        const policyPda = await enablePolicy(poolPda, agent, {
          referrer: referrerBytes,
          referrerPresent: 1,
          referrerShareBps: 1_000, // 10% of premium to referrer
          agentId: 'f1-3way-agent',
        });

        const beforeAgent = await getAccount(
          usdcFixture.connection,
          new PublicKey(agent.ata),
        );
        const beforeVault = await getAccount(
          usdcFixture.connection,
          new PublicKey(vaultPda),
        );
        const beforeTreasury = await getAccount(
          usdcFixture.connection,
          new PublicKey(treasuryAta),
        );
        const beforeReferrer = await getAccount(
          usdcFixture.connection,
          new PublicKey(referrerAta),
        );

        const ix = getSettlePremiumInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          treasuryAta,
          agentAta: agent.ata,
          oracleSigner,
          callValue: 4_000_000n,
          referrerTokenAccount: referrerAta,
        });
        await sendTx(h, oracleSigner, ix);

        const afterAgent = await getAccount(
          usdcFixture.connection,
          new PublicKey(agent.ata),
        );
        const afterVault = await getAccount(
          usdcFixture.connection,
          new PublicKey(vaultPda),
        );
        const afterTreasury = await getAccount(
          usdcFixture.connection,
          new PublicKey(treasuryAta),
        );
        const afterReferrer = await getAccount(
          usdcFixture.connection,
          new PublicKey(referrerAta),
        );

        // gross = 4_000_000 * 25 / 10_000 = 10_000
        // treasury_cut = 10_000 * 1500 / 10_000 = 1_500
        // referrer_cut = 10_000 * 1_000 / 10_000 = 1_000
        // pool_cut = 10_000 - 1_500 - 1_000 = 7_500
        const gross = 10_000n;
        const expectedTreasury = 1_500n;
        const expectedReferrer = 1_000n;
        const expectedPool = 7_500n;

        const spent = BigInt(beforeAgent.amount) - BigInt(afterAgent.amount);
        const poolDelta =
          BigInt(afterVault.amount) - BigInt(beforeVault.amount);
        const treasuryDelta =
          BigInt(afterTreasury.amount) - BigInt(beforeTreasury.amount);
        const referrerDelta =
          BigInt(afterReferrer.amount) - BigInt(beforeReferrer.amount);

        assert.equal(spent, gross, 'agent spent full gross');
        assert.equal(poolDelta, expectedPool, 'pool cut correct');
        assert.equal(treasuryDelta, expectedTreasury, 'treasury cut correct');
        assert.equal(referrerDelta, expectedReferrer, 'referrer cut correct');
        assert.equal(
          poolDelta + treasuryDelta + referrerDelta,
          gross,
          'cuts sum to gross',
        );
      },
      counter,
    );

    // ---- F1 Test 6 — missing remaining_accounts -------------------
    await runCase(
      'F1: rejects when referrer_present==1 but remaining_accounts empty (TokenAccountMismatch 6005)',
      async () => {
        const hostname = 'f1-missing.settle.example.com';
        const { poolPda, vaultPda } = await makePool(hostname);
        const agent = await makeAgent();

        const referrerKp = Keypair.generate();
        const referrerBytes = new Uint8Array(referrerKp.publicKey.toBytes());

        const policyPda = await enablePolicy(poolPda, agent, {
          referrer: referrerBytes,
          referrerPresent: 1,
          referrerShareBps: 1_000,
        });

        // DO NOT pass referrerTokenAccount.
        const ix = getSettlePremiumInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          treasuryAta,
          agentAta: agent.ata,
          oracleSigner,
          callValue: 4_000_000n,
        });

        const expected = 6005;
        const hex = expected.toString(16);
        const pattern = new RegExp(`#${expected}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(h, oracleSigner, ix);
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected TokenAccountMismatch (${expected}), got: ${detail}`,
          );
        }
        assert(threw, 'missing referrer ATA must reject');
      },
      counter,
    );

    // ---- F1 Test 7 — wrong-owner referrer ATA ---------------------
    await runCase(
      'F1: rejects when referrer ATA has wrong owner (TokenAccountMismatch 6005)',
      async () => {
        const hostname = 'f1-wrong-owner.example.com';
        const { poolPda, vaultPda } = await makePool(hostname);
        const agent = await makeAgent();

        const claimedReferrer = Keypair.generate();
        const claimedReferrerBytes = new Uint8Array(
          claimedReferrer.publicKey.toBytes(),
        );

        const policyPda = await enablePolicy(poolPda, agent, {
          referrer: claimedReferrerBytes,
          referrerPresent: 1,
          referrerShareBps: 1_000,
        });

        // But pass an ATA owned by some OTHER pubkey.
        const imposter = Keypair.generate();
        const wrongOwnerAta = await createTokenAccountForOwner(
          usdcFixture,
          imposter.publicKey,
        );

        const ix = getSettlePremiumInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          treasuryAta,
          agentAta: agent.ata,
          oracleSigner,
          callValue: 4_000_000n,
          referrerTokenAccount: wrongOwnerAta,
        });

        const expected = 6005;
        const hex = expected.toString(16);
        const pattern = new RegExp(`#${expected}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(h, oracleSigner, ix);
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected TokenAccountMismatch (${expected}), got: ${detail}`,
          );
        }
        assert(threw, 'wrong-owner referrer ATA must reject');
      },
      counter,
    );

    // ---- F1 Test 8 — wrong-mint referrer ATA ----------------------
    await runCase(
      'F1: rejects when referrer ATA has wrong mint (TokenAccountMismatch 6005)',
      async () => {
        const hostname = 'f1-wrong-mint.settle.example.com';
        const { poolPda, vaultPda } = await makePool(hostname);
        const agent = await makeAgent();

        const referrerKp = Keypair.generate();
        const referrerBytes = new Uint8Array(referrerKp.publicKey.toBytes());

        const policyPda = await enablePolicy(poolPda, agent, {
          referrer: referrerBytes,
          referrerPresent: 1,
          referrerShareBps: 1_000,
        });

        // Create a second mint + ATA for referrer under the WRONG mint.
        const wrongMintFixture = await createUsdcMint(h.endpoint);
        const wrongMintAta = await createTokenAccountForOwner(
          wrongMintFixture,
          referrerKp.publicKey,
        );

        const ix = getSettlePremiumInstruction({
          config: protocolPda,
          pool: poolPda,
          vault: vaultPda,
          policy: policyPda,
          treasuryAta,
          agentAta: agent.ata,
          oracleSigner,
          callValue: 4_000_000n,
          referrerTokenAccount: wrongMintAta,
        });

        const expected = 6005;
        const hex = expected.toString(16);
        const pattern = new RegExp(`#${expected}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(h, oracleSigner, ix);
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected TokenAccountMismatch (${expected}), got: ${detail}`,
          );
        }
        assert(threw, 'wrong-mint referrer ATA must reject');
      },
      counter,
    );
  } finally {
    console.log('[wp14] stopping validator...');
    await stopValidator(h);
  }

  if (counter.failures > 0) {
    console.error(`[wp14] ${counter.failures} test(s) failed`);
    process.exit(1);
  }
  console.log('[wp14] all migrated tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
