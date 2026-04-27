// Seed devnet coverage pools under the Pinocchio program ID (7i9zJ...).
//
// Idempotent. For each hostname:
//   1. If pool PDA already exists, skip pool creation.
//   2. Generate a fresh underwriter keypair, fund it ~0.05 SOL.
//   3. Create the underwriter's USDC ATA, mint DEPOSIT_USDC into it.
//   4. Deposit into the pool.
//
// USDC mint is read live from ProtocolConfig — never hardcoded here.
// Zero Anchor/@coral-xyz imports.  Uses @solana/kit for on-chain calls
// and @solana/spl-token + @solana/web3.js (already a dev-dep) only for
// SPL token account creation and minting, matching the pool.ts test pattern.
//
// Usage:
//   pnpm tsx packages/program/scripts/seed-devnet-pools-pinocchio.ts

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  appendTransactionMessageInstruction,
  address,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  createAccount,
  getMint,
  mintToChecked,
} from '@solana/spl-token';

import {
  getCreatePoolInstruction,
  getDepositInstruction,
  findProtocolConfigPda,
  findCoveragePoolPda,
  findCoveragePoolVaultPda,
  findUnderwriterPositionPda,
  decodeProtocolConfig,
  decodeCoveragePool,
  PACT_INSURANCE_PROGRAM_ADDRESS,
} from '../../insurance/src/generated/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = 'https://api.devnet.solana.com';
const DEPOSIT_USDC = 100_000_000n; // 100 USDC (6 decimals)

const HOSTNAMES = [
  'api.helius.xyz',
  'solana-mainnet.quiknode.pro',
  'quote-api.jup.ag',
  'api.coingecko.com',
  'api.dexscreener.com',
];

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypairBytes(p: string): Uint8Array {
  const resolved = p.startsWith('~') ? resolve(homedir(), p.slice(2)) : p;
  const raw = JSON.parse(readFileSync(resolved, 'utf-8')) as number[];
  return Uint8Array.from(raw);
}

function keypairBytesToWeb3(bytes: Uint8Array): Keypair {
  return Keypair.fromSecretKey(bytes);
}

async function waitForSignature(rpc: any, sig: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { value: statuses } = await rpc.getSignatureStatuses([sig as any]).send();
    const status = statuses[0];
    if (status) {
      if (status.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tx ${sig} not confirmed within ${timeoutMs}ms`);
}

async function sendTx(rpc: any, payer: KeyPairSigner, ix: any): Promise<string> {
  const { value: latest } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();
  await waitForSignature(rpc, sig);
  return sig;
}

async function fundFromPhantom(
  conn: Connection,
  phantom: Keypair,
  recipient: PublicKey,
  lamports: number,
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: phantom.publicKey, toPubkey: recipient, lamports }),
  );
  const sig = await conn.sendTransaction(tx, [phantom]);
  await conn.confirmTransaction(sig, 'confirmed');
}

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const phantomPath =
    process.env.ANCHOR_WALLET ??
    resolve(homedir(), '.config/solana/phantom-devnet.json');
  const oraclePath =
    process.env.ORACLE_KEYPAIR_PATH ??
    resolve(__dirname, '../../backend/.secrets/oracle-keypair.json');

  const phantomBytes = loadKeypairBytes(phantomPath);
  const phantomWeb3 = keypairBytesToWeb3(phantomBytes);
  const phantom: KeyPairSigner = await createKeyPairSignerFromBytes(phantomBytes);

  // Oracle keypair — generate & save if missing (uses web3.js for exportable key)
  let oracleBytes: Uint8Array;
  if (!existsSync(oraclePath)) {
    log('init', 'oracle keypair not found — generating and saving');
    const oracleKp = Keypair.generate();
    oracleBytes = oracleKp.secretKey; // 64-byte Ed25519 secret key
    writeFileSync(oraclePath, JSON.stringify(Array.from(oracleBytes)));
    log('init', `oracle keypair saved to ${oraclePath}`);
  } else {
    oracleBytes = loadKeypairBytes(oraclePath);
  }
  const oracleWeb3 = keypairBytesToWeb3(oracleBytes);

  const rpc = createSolanaRpc(RPC_URL);
  const conn = new Connection(RPC_URL, 'confirmed');

  // Balance guard
  const { value: lamports } = await rpc.getBalance(phantom.address).send();
  const sol = Number(lamports) / 1_000_000_000;
  log('init', `Program: ${PACT_INSURANCE_PROGRAM_ADDRESS}`);
  log('init', `Phantom: ${phantom.address}  (${sol.toFixed(4)} SOL)`);
  log('init', `Oracle:  ${oracleWeb3.publicKey.toBase58()}`);

  if (sol < 1) {
    console.error(`ABORT: deployer balance ${sol} SOL < 1 SOL minimum`);
    process.exit(1);
  }

  const solBefore = sol;

  // Fund oracle if low
  const oracleBalance = await conn.getBalance(oracleWeb3.publicKey);
  if (oracleBalance / LAMPORTS_PER_SOL < 0.05) {
    log('init', `Oracle balance low (${oracleBalance / LAMPORTS_PER_SOL} SOL) — topping up`);
    await fundFromPhantom(conn, phantomWeb3, oracleWeb3.publicKey, 0.1 * LAMPORTS_PER_SOL);
  }

  // Read ProtocolConfig live
  const [protocolPda] = await findProtocolConfigPda();
  log('init', `Protocol PDA: ${protocolPda}`);

  const { value: cfgAcct } = await rpc.getAccountInfo(protocolPda, { encoding: 'base64' }).send();
  if (!cfgAcct) {
    console.error('ABORT: ProtocolConfig not initialized. Run init-devnet-pinocchio.ts first.');
    process.exit(1);
  }
  const cfg = decodeProtocolConfig(new Uint8Array(Buffer.from(cfgAcct.data[0], 'base64')));
  const usdcMint = cfg.usdcMint;
  const usdcMintPk = new PublicKey(usdcMint);
  log('init', `config.usdcMint: ${usdcMint}`);

  // Sanity check: phantom must be mint authority to mint test USDC
  const mintInfo = await getMint(conn, usdcMintPk);
  if (!mintInfo.mintAuthority || mintInfo.mintAuthority.toBase58() !== phantomWeb3.publicKey.toBase58()) {
    console.error(
      `ABORT: phantom is not mint authority on ${usdcMint}. ` +
      `mint authority = ${mintInfo.mintAuthority?.toBase58() ?? 'null'}`,
    );
    process.exit(1);
  }

  const results: Array<{ hostname: string; poolPda: string; depositTx: string | null; skipped: boolean }> = [];

  for (const hostname of HOSTNAMES) {
    log('pool', `=== ${hostname} ===`);

    const [poolPda] = await findCoveragePoolPda(hostname);
    const [vaultPda] = await findCoveragePoolVaultPda(poolPda);

    log('pool', `pool PDA:  ${poolPda}`);
    log('pool', `vault PDA: ${vaultPda}`);

    const { value: existingPool } = await rpc.getAccountInfo(poolPda, { encoding: 'base64' }).send();

    if (existingPool) {
      log('pool', 'already exists — skipping create_pool');
      results.push({ hostname, poolPda, depositTx: null, skipped: true });
      continue;
    }

    // create_pool
    let createSig: string;
    try {
      const createIx = getCreatePoolInstruction({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        poolUsdcMint: usdcMint,
        authority: phantom,
        args: {
          providerHostname: hostname,
          insuranceRateBps: null,
          maxCoveragePerCall: null,
        },
      });
      createSig = await sendTx(rpc, phantom, createIx);
      log('pool', `created (sig ${createSig})`);
    } catch (err: any) {
      log('FAIL', `create_pool failed for ${hostname}: ${err?.message ?? err}`);
      results.push({ hostname, poolPda, depositTx: null, skipped: false });
      continue;
    }

    // Fresh underwriter per pool — use web3.js keypair so we can wrap as kit signer
    // without needing CryptoKey extraction.
    const uwWeb3 = Keypair.generate();
    const uwKitSigner: KeyPairSigner = await createKeyPairSignerFromBytes(uwWeb3.secretKey);

    log('uw', `underwriter: ${uwKitSigner.address}`);
    await fundFromPhantom(conn, phantomWeb3, uwWeb3.publicKey, 0.05 * LAMPORTS_PER_SOL);

    // Create ATA for underwriter (web3.js path — spl-token expects web3.js types)
    const underwriterAta = await createAccount(conn, phantomWeb3, usdcMintPk, uwWeb3.publicKey);
    log('uw', `ATA: ${underwriterAta.toBase58()}`);

    // Mint DEPOSIT_USDC into the underwriter's ATA
    await mintToChecked(conn, phantomWeb3, usdcMintPk, underwriterAta, phantomWeb3, DEPOSIT_USDC, 6);
    log('uw', `minted ${DEPOSIT_USDC} (raw)`);

    // deposit
    const [positionPda] = await findUnderwriterPositionPda(poolPda, uwKitSigner.address);

    let depositSig: string;
    try {
      const depositIx = getDepositInstruction({
        config: protocolPda,
        pool: poolPda,
        vault: vaultPda,
        position: positionPda,
        underwriterTokenAccount: address(underwriterAta.toBase58()),
        underwriter: uwKitSigner,
        amount: DEPOSIT_USDC,
      });
      depositSig = await sendTx(rpc, uwKitSigner, depositIx);
      log('uw', `deposit confirmed (sig ${depositSig})`);
    } catch (err: any) {
      log('FAIL', `deposit failed for ${hostname}: ${err?.message ?? err}`);
      results.push({ hostname, poolPda, depositTx: null, skipped: false });
      continue;
    }

    // Fetch and log pool summary
    const { value: poolAcct } = await rpc.getAccountInfo(poolPda, { encoding: 'base64' }).send();
    if (poolAcct) {
      const pool = decodeCoveragePool(new Uint8Array(Buffer.from(poolAcct.data[0], 'base64')));
      log(
        'summary',
        `${hostname} totalDeposited=${pool.totalDeposited} totalAvailable=${pool.totalAvailable} rate=${pool.insuranceRateBps}bps`,
      );
    }

    results.push({ hostname, poolPda, depositTx: depositSig, skipped: false });

    await new Promise((r) => setTimeout(r, 750));
  }

  // Post-seed balance
  const { value: lamportsAfter } = await rpc.getBalance(phantom.address).send();
  const solAfter = Number(lamportsAfter) / 1_000_000_000;

  console.log('');
  console.log('SEED_DONE=true');
  console.log(`SEED_PROTOCOL_PDA=${protocolPda}`);
  console.log(`SEED_USDC_MINT=${usdcMint}`);
  for (const r of results) {
    const status = r.skipped ? 'skipped' : r.depositTx ? `deposited tx=${r.depositTx}` : 'FAILED';
    console.log(`SEED_POOL[${r.hostname}]=${r.poolPda}  ${status}`);
  }
  console.log('');
  console.log(`Balance before: ${solBefore.toFixed(9)} SOL`);
  console.log(`Balance after:  ${solAfter.toFixed(9)} SOL`);
  console.log(`Delta:          ${(solAfter - solBefore).toFixed(9)} SOL`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
