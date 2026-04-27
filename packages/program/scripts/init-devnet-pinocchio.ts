// Initialize the Pinocchio pact_insurance program on devnet.
//
// Idempotent: if ProtocolConfig PDA already exists, logs and exits without
// sending a transaction.
//
// Zero Anchor/web3.js imports — pure @solana/kit + Codama.
//
// Usage:
//   ANCHOR_WALLET=~/.config/solana/phantom-devnet.json \
//   ORACLE_KEYPAIR_PATH=packages/backend/.secrets/oracle-keypair.json \
//   pnpm tsx packages/program/scripts/init-devnet-pinocchio.ts

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSolanaRpc,
  createKeyPairSignerFromBytes,
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
  findProtocolConfigPda,
  decodeProtocolConfig,
  PACT_INSURANCE_PROGRAM_ADDRESS,
} from '../../insurance/src/generated/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = 'https://api.devnet.solana.com';
const DEVNET_USDC_MINT = '5vcEdU8fBksfRH42wrebUV6dNEENPbdaBtAmw79ZNuSE' as Address;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypairBytes(p: string): Uint8Array {
  const resolved = p.startsWith('~') ? resolve(homedir(), p.slice(2)) : p;
  const raw = JSON.parse(readFileSync(resolved, 'utf-8'));
  return Uint8Array.from(raw as number[]);
}

async function waitForSignature(rpc: any, sig: string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { value: statuses } = await rpc.getSignatureStatuses([sig as any]).send();
    const status = statuses[0];
    if (status) {
      if (status.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`tx ${sig} not confirmed within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const walletPath =
    process.env.ANCHOR_WALLET ??
    resolve(homedir(), '.config/solana/phantom-devnet.json');
  const oraclePath =
    process.env.ORACLE_KEYPAIR_PATH ??
    resolve(__dirname, '../../backend/.secrets/oracle-keypair.json');

  const deployerBytes = loadKeypairBytes(walletPath);
  const oracleBytes = loadKeypairBytes(oraclePath);

  const deployer: KeyPairSigner = await createKeyPairSignerFromBytes(deployerBytes);
  const oracle: KeyPairSigner = await createKeyPairSignerFromBytes(oracleBytes);

  const rpc = createSolanaRpc(RPC_URL);

  // Balance guard
  const { value: lamports } = await rpc.getBalance(deployer.address).send();
  const sol = Number(lamports) / 1_000_000_000;
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Oracle:   ${oracle.address}`);
  console.log(`Treasury: ${deployer.address} (= deployer)`);
  console.log(`USDC mint (devnet): ${DEVNET_USDC_MINT}`);
  console.log(`Program ID: ${PACT_INSURANCE_PROGRAM_ADDRESS}`);
  console.log(`Balance: ${sol.toFixed(9)} SOL`);

  if (sol < 1) {
    console.error(`ABORT: deployer balance ${sol} SOL < 1 SOL minimum`);
    process.exit(1);
  }

  const [protocolPda] = await findProtocolConfigPda();
  console.log(`Protocol PDA: ${protocolPda}`);
  console.log('');

  // Idempotency check
  const { value: existing } = await rpc.getAccountInfo(protocolPda, { encoding: 'base64' }).send();
  if (existing) {
    const raw = Buffer.from(existing.data[0], 'base64');
    const cfg = decodeProtocolConfig(new Uint8Array(raw));
    console.log('already initialized — existing PDA:', protocolPda);
    console.log('  authority:        ', cfg.authority);
    console.log('  oracle:           ', cfg.oracle);
    console.log('  treasury:         ', cfg.treasury);
    console.log('  usdc_mint:        ', cfg.usdcMint);
    console.log('  protocol_fee_bps: ', cfg.protocolFeeBps);
    console.log('  paused:           ', cfg.paused);
    return;
  }

  console.log('Protocol not initialized. Sending initialize_protocol...');

  const ix = getInitializeProtocolInstruction({
    config: protocolPda,
    deployer,
    args: {
      authority: deployer.address,
      oracle: oracle.address,
      treasury: deployer.address,
      usdcMint: DEVNET_USDC_MINT,
    },
  });

  const { value: latest } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(deployer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();

  console.log('Waiting for confirmation...');
  await waitForSignature(rpc, sig);
  console.log('');
  console.log('Initialized. Transaction:', sig);
  console.log('Explorer:', `https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  const { value: fresh } = await rpc.getAccountInfo(protocolPda, { encoding: 'base64' }).send();
  if (fresh) {
    const cfg = decodeProtocolConfig(new Uint8Array(Buffer.from(fresh.data[0], 'base64')));
    console.log('');
    console.log('Final config:');
    console.log('  authority:              ', cfg.authority);
    console.log('  oracle:                 ', cfg.oracle);
    console.log('  treasury:               ', cfg.treasury);
    console.log('  usdc_mint:              ', cfg.usdcMint);
    console.log('  protocol_fee_bps:       ', cfg.protocolFeeBps);
    console.log('  min_pool_deposit:       ', cfg.minPoolDeposit.toString(), '(raw)');
    console.log('  withdrawal_cooldown:    ', cfg.withdrawalCooldownSeconds.toString(), 's');
    console.log('  aggregate_cap_bps:      ', cfg.aggregateCapBps);
    console.log('  aggregate_cap_window:   ', cfg.aggregateCapWindowSeconds.toString(), 's');
    console.log('  paused:                 ', cfg.paused);
  }

  console.log('');
  console.log(`INIT_PROTOCOL_PDA=${protocolPda}`);
  console.log(`INIT_TX=${sig}`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
