// WP-8 migration target: the `pool.ts` happy-path + duplicate cases, plus a
// NEW mint-check test that validates Alan's locked `create_pool` fix (spec
// §8.2 — Anchor never enforced `pool_usdc_mint == config.usdc_mint`).
//
// Runs against `solana-test-validator` pre-loaded with the Pinocchio `.so`.
// The SPL Token Program is always present on the default validator, so no
// `--bpf-program` override is needed for it.
//
// Run with:
//   pnpm tsx tests-pinocchio/pool.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

import {
  address,
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
  type Address,
  type KeyPairSigner,
} from '@solana/kit';

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { createMint } from '@solana/spl-token';

import {
  getInitializeProtocolInstruction,
  getCreatePoolInstruction,
  getUpdateRatesInstruction,
  findProtocolConfigPda,
  findCoveragePoolPda,
  findCoveragePoolVaultPda,
  decodeCoveragePool,
  getCoveragePoolHostname,
  PACT_INSURANCE_PROGRAM_ADDRESS,
} from '../../insurance/src/generated/index.js';

// ---------------------------------------------------------------------------
// Validator harness (mirrors tests-pinocchio/protocol.ts)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRAM_ROOT = resolve(__dirname, '..');
const PINOCCHIO_SO = resolve(
  PROGRAM_ROOT,
  'target/deploy/pact_insurance_pinocchio.so',
);

const RPC_PORT = 9899 + Math.floor(Math.random() * 1000);
// Validator conventions: RPC on RPC_PORT, websocket on RPC_PORT+1, faucet
// must be on a third distinct port (otherwise faucet stomps the PubSub
// socket and airdrops silently hang behind ws Parse errors).
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

  const ledger = await mkdtemp(resolve(tmpdir(), 'pact-pino-ledger-pool-'));
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
    console.log(`[wp8] PASS: ${label}`);
  } catch (err) {
    counter.failures++;
    console.error(`[wp8] FAIL: ${label} —`, err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a 6-decimal USDC-shaped mint via @solana/spl-token + web3.js. Uses
 * a disposable web3.js Keypair as fee-payer — airdropped out of band — to
 * sidestep the kit-signer ↔ v1-Keypair interop dance.
 */
async function createUsdcMint(endpoint: string): Promise<Address> {
  const conn = new Connection(endpoint, 'confirmed');
  const payer = Keypair.generate();
  const sig = await conn.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');

  const mint = await createMint(
    conn,
    payer,
    payer.publicKey,
    null,
    6,
  );
  return address(mint.toBase58());
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('[wp8] starting validator...');
  const h = await startValidator();
  const counter = { failures: 0 };
  try {
    const [protocolPda] = await findProtocolConfigPda();
    const deployer = await fundedSigner(h, 20);
    const authority = await fundedSigner(h, 10);
    const oracleSigner = await generateKeyPairSigner();
    const oracle = oracleSigner.address;
    const treasury = (await generateKeyPairSigner()).address;

    // The config-bound USDC mint — create before initializeProtocol so we can
    // feed its address as `usdcMint`.
    const usdcMint = await createUsdcMint(h.endpoint);

    // ---- bootstrap: initialize_protocol ---------------------------------
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
          usdcMint,
        },
      }),
    );

    const hostname = 'api.helius.xyz';
    const [poolPda] = await findCoveragePoolPda(hostname);
    const [vaultPda] = await findCoveragePoolVaultPda(poolPda);

    // ---- Test 1 — creates a pool (happy path) ---------------------------
    await runCase(
      'creates a pool for a provider hostname',
      async () => {
        await sendTx(
          h,
          authority,
          getCreatePoolInstruction({
            config: protocolPda,
            pool: poolPda,
            vault: vaultPda,
            poolUsdcMint: usdcMint,
            authority,
            args: {
              providerHostname: hostname,
              insuranceRateBps: null,
              maxCoveragePerCall: null,
            },
          }),
        );

        const { value: acct } = await h.rpc
          .getAccountInfo(poolPda, { encoding: 'base64' })
          .send();
        assert(acct, 'pool account should exist');
        const raw = Buffer.from(acct.data[0], 'base64');
        const pool = decodeCoveragePool(new Uint8Array(raw));

        assert.equal(pool.discriminator, 1);
        assert.equal(getCoveragePoolHostname(pool), hostname);
        assert.equal(pool.providerHostnameLen, hostname.length);
        assert.equal(pool.insuranceRateBps, 25); // DEFAULT_INSURANCE_RATE_BPS
        assert.equal(pool.minPremiumBps, 5); // DEFAULT_MIN_PREMIUM_BPS
        assert.equal(pool.maxCoveragePerCall, 1_000_000n); // DEFAULT_MAX_COVERAGE_PER_CALL
        assert.equal(pool.totalDeposited, 0n);
        assert.equal(pool.totalAvailable, 0n);
        assert.equal(pool.totalPremiumsEarned, 0n);
        assert.equal(pool.totalClaimsPaid, 0n);
        assert.equal(pool.payoutsThisWindow, 0n);
        assert.equal(pool.activePolicies, 0);
        assert.equal(pool.authority, authority.address);
        assert.equal(pool.usdcMint, usdcMint);
        assert.equal(pool.vault, vaultPda);
        assert.ok(pool.bump > 0, 'pool bump populated');
        // WP-8 stashes vault_bump in _pad_tail[0] for hot-path readers.
        assert.ok(pool.padTail[0]! > 0, 'vault bump stashed in padTail[0]');

        // Verify the vault is an SPL Token account owned by the Token Program
        // with `mint = usdcMint` and `authority = poolPda`.
        const { value: vaultAcct } = await h.rpc
          .getAccountInfo(vaultPda, { encoding: 'base64' })
          .send();
        assert(vaultAcct, 'vault account should exist');
        assert.equal(
          vaultAcct.owner,
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          'vault owned by SPL Token Program',
        );
        const vaultRaw = Buffer.from(vaultAcct.data[0], 'base64');
        assert.equal(vaultRaw.length, 165, 'SPL Token account size');
        // Token account layout: mint bytes 0..32, owner bytes 32..64.
        const vaultMintBytes = vaultRaw.subarray(0, 32);
        const vaultOwnerBytes = vaultRaw.subarray(32, 64);
        assert.equal(
          new PublicKey(vaultMintBytes).toBase58(),
          usdcMint,
          'vault.mint == usdcMint',
        );
        assert.equal(
          new PublicKey(vaultOwnerBytes).toBase58(),
          poolPda,
          'vault.owner == poolPda',
        );
      },
      counter,
    );

    // ---- WP-11 — update_rates (disc 9) ----------------------------------
    //
    // Oracle-signed rate clamp. The pool created above has insuranceRateBps
    // initialized to DEFAULT_INSURANCE_RATE_BPS (25) and minPremiumBps
    // initialized to DEFAULT_MIN_PREMIUM_BPS (5).

    // Non-oracle signer used to prove UnauthorizedOracle (6025).
    // Funded as tx fee-payer so we can sign the outer transaction with
    // `rando` itself and still submit it.
    const rando = await fundedSigner(h, 1);

    await runCase(
      'WP-11: updates pool insurance_rate_bps via update_rates (oracle-signed)',
      async () => {
        await sendTx(
          h,
          authority,
          getUpdateRatesInstruction({
            config: protocolPda,
            pool: poolPda,
            oracleSigner,
            newRateBps: 50,
          }),
        );

        const { value: acct } = await h.rpc
          .getAccountInfo(poolPda, { encoding: 'base64' })
          .send();
        assert(acct, 'pool account should exist');
        const pool = decodeCoveragePool(
          new Uint8Array(Buffer.from(acct.data[0], 'base64')),
        );
        assert.equal(pool.insuranceRateBps, 50);
        assert.ok(pool.updatedAt > 0n, 'updated_at stamped');
      },
      counter,
    );

    await runCase(
      'WP-11: rejects update_rates from non-oracle signer (UnauthorizedOracle 6025)',
      async () => {
        // UnauthorizedOracle = 6025 / 0x1789.
        const expectedCode = 6025;
        const hex = expectedCode.toString(16);
        const pattern = new RegExp(`#${expectedCode}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(
            h,
            rando,
            getUpdateRatesInstruction({
              config: protocolPda,
              pool: poolPda,
              oracleSigner: rando,
              newRateBps: 75,
            }),
          );
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected UnauthorizedOracle (${expectedCode}/0x${hex}), got: ${detail}`,
          );
        }
        assert(threw, 'update_rates must reject non-oracle signer');
      },
      counter,
    );

    await runCase(
      'WP-11 H-04: rejects rate > 10_000 (RateOutOfBounds 6027)',
      async () => {
        // RateOutOfBounds = 6027 / 0x178b.
        const expectedCode = 6027;
        const hex = expectedCode.toString(16);
        const pattern = new RegExp(`#${expectedCode}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(
            h,
            authority,
            getUpdateRatesInstruction({
              config: protocolPda,
              pool: poolPda,
              oracleSigner,
              newRateBps: 10_001,
            }),
          );
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected RateOutOfBounds (${expectedCode}/0x${hex}), got: ${detail}`,
          );
        }
        assert(threw, 'update_rates must reject rate > 10_000');
      },
      counter,
    );

    await runCase(
      'WP-11 H-04: rejects rate < pool.min_premium_bps (RateBelowFloor 6028)',
      async () => {
        // Fetch current pool.min_premium_bps — must be > 0 for a meaningful
        // below-floor test (DEFAULT_MIN_PREMIUM_BPS = 5 per create_pool).
        const { value: acct } = await h.rpc
          .getAccountInfo(poolPda, { encoding: 'base64' })
          .send();
        assert(acct, 'pool account should exist');
        const pool = decodeCoveragePool(
          new Uint8Array(Buffer.from(acct.data[0], 'base64')),
        );
        const minPremium = pool.minPremiumBps;
        assert.ok(
          minPremium > 0,
          `min_premium_bps must be > 0 for this test, got ${minPremium}`,
        );
        const belowFloor = minPremium - 1;

        // RateBelowFloor = 6028 / 0x178c.
        const expectedCode = 6028;
        const hex = expectedCode.toString(16);
        const pattern = new RegExp(`#${expectedCode}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(
            h,
            authority,
            getUpdateRatesInstruction({
              config: protocolPda,
              pool: poolPda,
              oracleSigner,
              newRateBps: belowFloor,
            }),
          );
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected RateBelowFloor (${expectedCode}/0x${hex}), got: ${detail}`,
          );
        }
        assert(threw, 'update_rates must reject rate < min_premium_bps');
      },
      counter,
    );

    // ---- Test 2 — rejects duplicate pool creation -----------------------
    await runCase(
      'rejects duplicate pool creation',
      async () => {
        let threw = false;
        try {
          await sendTx(
            h,
            authority,
            getCreatePoolInstruction({
              config: protocolPda,
              pool: poolPda,
              vault: vaultPda,
              poolUsdcMint: usdcMint,
              authority,
              args: {
                providerHostname: hostname,
                insuranceRateBps: null,
                maxCoveragePerCall: null,
              },
            }),
          );
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          // CreateAccount on an already-funded PDA surfaces either the
          // system program's "already in use" error, Pinocchio's uniform
          // AccountAlreadyInitialized (0x0) custom, or the validator's
          // preflight raw error string.
          assert.match(
            detail,
            /already in use|AccountAlreadyInitialized|uninitialized account|0x0\b|custom program error/i,
            `duplicate create should surface already-in-use, got: ${detail}`,
          );
        }
        assert(threw, 'duplicate create must reject');
      },
      counter,
    );

    // ---- Test 3 (NEW — Alan's locked mint-check) ------------------------
    await runCase(
      'rejects create_pool when usdc_mint != config.usdc_mint',
      async () => {
        // Create a second, wrong mint — config was bound to `usdcMint`, so
        // calling create_pool with this one must be rejected.
        const wrongMint = await createUsdcMint(h.endpoint);

        const wrongHostname = 'api.wrong.example';
        const [wrongPool] = await findCoveragePoolPda(wrongHostname);
        const [wrongVault] = await findCoveragePoolVaultPda(wrongPool);

        // Unauthorized = PactError code 18, offset from 6000 => 6018 / 0x1782.
        const expectedCode = 6018;
        const hex = expectedCode.toString(16);
        const pattern = new RegExp(`#${expectedCode}\\b|0x${hex}\\b`, 'i');

        let threw = false;
        try {
          await sendTx(
            h,
            authority,
            getCreatePoolInstruction({
              config: protocolPda,
              pool: wrongPool,
              vault: wrongVault,
              poolUsdcMint: wrongMint,
              authority,
              args: {
                providerHostname: wrongHostname,
                insuranceRateBps: null,
                maxCoveragePerCall: null,
              },
            }),
          );
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            pattern,
            `expected Unauthorized (${expectedCode}/0x${hex}), got: ${detail}`,
          );
        }
        assert(threw, 'create_pool must reject mismatched mint');
      },
      counter,
    );
  } finally {
    console.log('[wp8] stopping validator...');
    await stopValidator(h);
  }

  if (counter.failures > 0) {
    console.error(`[wp8] ${counter.failures} test(s) failed`);
    process.exit(1);
  }
  console.log('[wp8] all migrated tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
