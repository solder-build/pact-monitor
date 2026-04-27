// WP-5 migration target: the two `initialize_protocol` tests from
// `tests/protocol.ts`, rewritten against the Codama builder + `@solana/kit`.
// Runs against `solana-test-validator` pre-loaded with the Pinocchio `.so`.
//
// Run with:
//   pnpm tsx tests-pinocchio/protocol.ts
//
// The harness spawns its own validator on a random port + temp ledger. No
// external services are required beyond `solana-test-validator` being on
// `$PATH` (Agave install). The Anchor test suite is independent and still
// uses `anchor test`.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

import {
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
  getInitializeProtocolInstruction,
  getUpdateConfigInstruction,
  getUpdateOracleInstruction,
  findProtocolConfigPda,
  decodeProtocolConfig,
  PACT_INSURANCE_PROGRAM_ADDRESS,
  type UpdateConfigArgs,
} from '../../insurance/src/generated/index.js';

// ---------------------------------------------------------------------------
// Validator harness
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRAM_ROOT = resolve(__dirname, '..');
const PINOCCHIO_SO = resolve(
  PROGRAM_ROOT,
  'target/deploy/pact_insurance_pinocchio.so',
);

const RPC_PORT = 8899 + Math.floor(Math.random() * 1000);
const FAUCET_PORT = RPC_PORT + 1;

// Kit's `createSolanaRpc` returns a cluster-branded RPC union; localhost is
// not one of the tagged clusters, and the testnet-only methods we need
// (`requestAirdrop`) get pruned from the inferred type. For a test harness
// the pragmatic fix is to widen to `any` at the boundary.
interface Harness {
  proc: ChildProcess;
  ledger: string;
  rpc: any;
  rpcSubscriptions: any;
}

async function startValidator(): Promise<Harness> {
  if (!existsSync(PINOCCHIO_SO)) {
    throw new Error(
      `Pinocchio .so not found at ${PINOCCHIO_SO}. Run:\n  cargo build-sbf --manifest-path programs-pinocchio/pact-insurance-pinocchio/Cargo.toml --features bpf-entrypoint`,
    );
  }

  const ledger = await mkdtemp(resolve(tmpdir(), 'pact-pino-ledger-'));
  const proc = spawn(
    'solana-test-validator',
    [
      '--ledger',
      ledger,
      '--reset',
      '--quiet',
      '--rpc-port',
      String(RPC_PORT),
      '--faucet-port',
      String(FAUCET_PORT),
      '--bpf-program',
      PACT_INSURANCE_PROGRAM_ADDRESS,
      PINOCCHIO_SO,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  proc.on('error', (err) => {
    console.error('validator spawn error:', err);
  });

  const rpc = createSolanaRpc(`http://127.0.0.1:${RPC_PORT}`);
  const rpcSubscriptions = createSolanaRpcSubscriptions(
    `ws://127.0.0.1:${RPC_PORT + 1}`,
  );

  // Poll until getHealth succeeds.
  const started = Date.now();
  const timeoutMs = 60_000;
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await rpc.getHealth().send();
      if (health === 'ok') break;
    } catch (_) {
      // validator not ready
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return { proc, ledger, rpc, rpcSubscriptions };
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

async function sendInitialize(
  h: Harness,
  deployer: KeyPairSigner,
  config: Address,
  args: {
    authority: Address;
    oracle: Address;
    treasury: Address;
    usdcMint: Address;
  },
): Promise<void> {
  const ix = getInitializeProtocolInstruction({
    config,
    deployer,
    args,
  });
  const { value: latest } = await h.rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(deployer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await h.rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();
  await waitForSignature(h, sig);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Empty patch — every field `null` (encoded as Borsh `None`). */
function emptyArgs(): UpdateConfigArgs {
  return {
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
    usdcMint: null,
  };
}

async function sendUpdateConfig(
  h: Harness,
  payer: KeyPairSigner,
  authority: KeyPairSigner,
  config: Address,
  args: UpdateConfigArgs,
): Promise<void> {
  const ix = getUpdateConfigInstruction({
    config,
    authority,
    args,
  });
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
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();
  await waitForSignature(h, sig);
}

async function fetchConfig(h: Harness, pda: Address) {
  const { value: acct } = await h.rpc
    .getAccountInfo(pda, { encoding: 'base64' })
    .send();
  assert(acct, 'protocol config account should exist');
  const raw = Buffer.from(acct.data[0], 'base64');
  return decodeProtocolConfig(new Uint8Array(raw));
}

async function runCase(
  label: string,
  fn: () => Promise<void>,
  counter: { failures: number },
): Promise<void> {
  try {
    await fn();
    console.log(`[wp6] PASS: ${label}`);
  } catch (err) {
    counter.failures++;
    console.error(`[wp6] FAIL: ${label} —`, err);
  }
}

async function run() {
  console.log('[wp6] starting validator...');
  const h = await startValidator();
  const counter = { failures: 0 };
  try {
    const [protocolPda] = await findProtocolConfigPda();
    const deployer = await fundedSigner(h, 10);
    // WP-6: authority is now a real signer so it can call update_config.
    const authority = await fundedSigner(h, 2);
    const oracle = (await generateKeyPairSigner()).address;
    const treasury = (await generateKeyPairSigner()).address;
    const usdcMint = (await generateKeyPairSigner()).address;

    // ---- Test 1 (WP-5) — initialize with a separate authority and oracle ----
    await runCase(
      'initializes the protocol config with a separate authority and oracle',
      async () => {
        await sendInitialize(h, deployer, protocolPda, {
          authority: authority.address,
          oracle,
          treasury,
          usdcMint,
        });

        const cfg = await fetchConfig(h, protocolPda);
        assert.equal(cfg.discriminator, 0);
        assert.equal(cfg.authority, authority.address);
        assert.equal(cfg.oracle, oracle);
        assert.equal(cfg.treasury, treasury);
        assert.equal(cfg.usdcMint, usdcMint);
        assert.notEqual(cfg.authority, deployer.address);
        assert.notEqual(cfg.authority, cfg.oracle);
        assert.equal(cfg.protocolFeeBps, 1500);
        assert.equal(cfg.minPoolDeposit, 100_000_000n);
        assert.equal(cfg.withdrawalCooldownSeconds, 604_800n);
        assert.equal(cfg.aggregateCapBps, 3000);
        assert.equal(cfg.aggregateCapWindowSeconds, 86_400n);
        assert.equal(cfg.paused, 0);
      },
      counter,
    );

    // ---- Test 2 (WP-5) — reject second init ----
    await runCase(
      'rejects second initialization (PDA already exists)',
      async () => {
        let threw = false;
        try {
          await sendInitialize(h, deployer, protocolPda, {
            authority: authority.address,
            oracle,
            treasury,
            usdcMint,
          });
        } catch (err) {
          threw = true;
          const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.match(
            detail,
            /already in use|AccountAlreadyInitialized|already initialized|0x0|custom program error|requires an uninitialized account/i,
            `second init should surface account-already-in-use, got: ${detail}`,
          );
        }
        assert(threw, 'second init must reject');
      },
      counter,
    );

    // Helper — drive an update_config tx that is EXPECTED to fail with a
    // specific PactError code. The kit RPC surfaces this in two shapes:
    //   1. `"Custom program error: #6022 (instruction #N)"` (decimal, `#` prefix)
    //   2. `"custom program error: 0x1786"` (hex, raw validator output)
    // The helper accepts the decimal code and matches both.
    const expectReject = async (
      args: UpdateConfigArgs,
      expectedCode: number,
      signer: KeyPairSigner = authority,
    ) => {
      const hex = expectedCode.toString(16);
      const decPattern = `#${expectedCode}\\b`;
      const hexPattern = `0x${hex}\\b`;
      const pattern = new RegExp(`${decPattern}|${hexPattern}`, 'i');
      let threw = false;
      try {
        await sendUpdateConfig(h, deployer, signer, protocolPda, args);
      } catch (err) {
        threw = true;
        const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
        assert.match(
          detail,
          pattern,
          `expected custom error ${expectedCode} (0x${hex}), got: ${detail}`,
        );
      }
      assert(threw, 'update_config must reject');
    };

    // ---- Test 3 — updates protocol_fee_bps when authority calls ----
    await runCase(
      'updates protocol_fee_bps when authority calls update_config',
      async () => {
        await sendUpdateConfig(h, deployer, authority, protocolPda, {
          ...emptyArgs(),
          protocolFeeBps: 2000,
        });
        const cfg = await fetchConfig(h, protocolPda);
        assert.equal(cfg.protocolFeeBps, 2000);
      },
      counter,
    );

    // ---- Test 4 — rejects protocol_fee_bps above ABSOLUTE_MAX (3000) ----
    await runCase(
      'rejects protocol_fee_bps above ABSOLUTE_MAX (3000)',
      async () => {
        await expectReject(
          { ...emptyArgs(), protocolFeeBps: 3500 },
          6022,
        );
      },
      counter,
    );

    // ---- Test 5 — rejects withdrawal_cooldown below ABSOLUTE_MIN (3600) ----
    await runCase(
      'rejects withdrawal_cooldown below ABSOLUTE_MIN (3600)',
      async () => {
        await expectReject(
          { ...emptyArgs(), withdrawalCooldownSeconds: 1000n },
          6022,
        );
      },
      counter,
    );

    // ---- Test 6 — rejects aggregate_cap_bps above ABSOLUTE_MAX (8000) ----
    await runCase(
      'rejects aggregate_cap_bps above ABSOLUTE_MAX (8000)',
      async () => {
        await expectReject(
          { ...emptyArgs(), aggregateCapBps: 9000 },
          6022,
        );
      },
      counter,
    );

    // ---- Test 7 — rejects update_config from non-authority ----
    await runCase(
      'rejects update_config from non-authority',
      async () => {
        const rando = await fundedSigner(h, 1);
        await expectReject(
          { ...emptyArgs(), protocolFeeBps: 500 },
          6018,
          rando,
        );
      },
      counter,
    );

    // ---- Test 8 — rejects min_pool_deposit below ABSOLUTE_MIN (1_000_000) ----
    await runCase(
      'rejects min_pool_deposit below ABSOLUTE_MIN (1_000_000)',
      async () => {
        await expectReject(
          { ...emptyArgs(), minPoolDeposit: 500_000n },
          6022,
        );
      },
      counter,
    );

    // ---- Test 9 — rejects claim_window_seconds below ABSOLUTE_MIN (60) ----
    await runCase(
      'rejects claim_window_seconds below ABSOLUTE_MIN (60)',
      async () => {
        await expectReject(
          { ...emptyArgs(), claimWindowSeconds: 10n },
          6022,
        );
      },
      counter,
    );

    // ---- Test 10 (H-03) — rejects treasury mutation ----
    await runCase(
      'H-03: update_config rejects treasury mutation',
      async () => {
        const newTreasury = (await generateKeyPairSigner()).address;
        await expectReject(
          { ...emptyArgs(), treasury: newTreasury },
          6026,
        );
      },
      counter,
    );

    // ---- Test 11 (H-03) — rejects usdc_mint mutation ----
    await runCase(
      'H-03: update_config rejects usdc_mint mutation',
      async () => {
        const newMint = (await generateKeyPairSigner()).address;
        await expectReject(
          { ...emptyArgs(), usdcMint: newMint },
          6026,
        );
      },
      counter,
    );

    // -----------------------------------------------------------------------
    // WP-7 — update_oracle (disc 2). Migrates the 4 C-02 cases from
    // packages/program/tests/security-hardening.ts. InvalidOracleKey (6030)
    // is reused for both zero-pubkey and oracle==authority — matches the
    // Anchor source. Non-authority signer hits Unauthorized (6018).
    // -----------------------------------------------------------------------

    const sendUpdateOracle = async (
      signer: KeyPairSigner,
      newOracle: Address,
    ): Promise<void> => {
      const ix = getUpdateOracleInstruction({
        config: protocolPda,
        authority: signer,
        newOracle,
      });
      const { value: latest } = await h.rpc.getLatestBlockhash().send();
      const msg = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(deployer, m),
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
    };

    const expectUpdateOracleReject = async (
      signer: KeyPairSigner,
      newOracle: Address,
      expectedCode: number,
    ) => {
      const hex = expectedCode.toString(16);
      const pattern = new RegExp(`#${expectedCode}\\b|0x${hex}\\b`, 'i');
      let threw = false;
      try {
        await sendUpdateOracle(signer, newOracle);
      } catch (err) {
        threw = true;
        const detail = JSON.stringify(err, Object.getOwnPropertyNames(err));
        assert.match(
          detail,
          pattern,
          `expected custom error ${expectedCode} (0x${hex}), got: ${detail}`,
        );
      }
      assert(threw, 'update_oracle must reject');
    };

    // ---- Test 12 (C-02) — rotates oracle when authority calls ----
    await runCase(
      'C-02: rotates oracle when authority calls update_oracle',
      async () => {
        const newOracle = (await generateKeyPairSigner()).address;
        await sendUpdateOracle(authority, newOracle);
        const cfg = await fetchConfig(h, protocolPda);
        assert.equal(cfg.oracle, newOracle);
        // Restore the original oracle so downstream state reads stay
        // well-defined for any future test addition.
        await sendUpdateOracle(authority, oracle);
        const restored = await fetchConfig(h, protocolPda);
        assert.equal(restored.oracle, oracle);
      },
      counter,
    );

    // ---- Test 13 (C-02) — rejects update_oracle from non-authority ----
    await runCase(
      'C-02: rejects update_oracle from non-authority',
      async () => {
        const rando = await fundedSigner(h, 1);
        const candidate = (await generateKeyPairSigner()).address;
        await expectUpdateOracleReject(rando, candidate, 6018);
      },
      counter,
    );

    // ---- Test 14 (C-02) — rejects update_oracle with zero pubkey ----
    await runCase(
      'C-02: rejects update_oracle with zero pubkey',
      async () => {
        // `11111111111111111111111111111111` is the canonical base58 encoding
        // of the all-zero 32-byte array (System Program). Casting via
        // `Address` keeps typing honest; the handler strictly compares bytes.
        const zero = '11111111111111111111111111111111' as Address;
        await expectUpdateOracleReject(authority, zero, 6030);
      },
      counter,
    );

    // ---- Test 15 (C-02) — rejects new_oracle == authority ----
    await runCase(
      'C-02: rejects update_oracle with new_oracle == authority',
      async () => {
        await expectUpdateOracleReject(authority, authority.address, 6030);
      },
      counter,
    );
  } finally {
    console.log('[wp6] stopping validator...');
    await stopValidator(h);
  }

  if (counter.failures > 0) {
    console.error(`[wp6] ${counter.failures} test(s) failed`);
    process.exit(1);
  }
  console.log('[wp6] all migrated tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
