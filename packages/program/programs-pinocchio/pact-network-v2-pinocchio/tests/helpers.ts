/**
 * LiteSVM test harness for `pact-network-v2-pinocchio`.
 *
 * Boots a fresh `LiteSVM` instance per test file, loads the V2 `.so` binary
 * at the canonical `PROGRAM_ID` (from `@q3labs/pact-protocol-v2-client`),
 * and exposes:
 *
 *  - `loadProgram(svm, opts)` — load `.so`, set clock, set compute budget.
 *    `opts.bypass = true` loads the `--features unsafe-bypass-deployer`
 *    artifact; `false` loads the no-bypass (production-like) artifact. The
 *    bypass flag is REQUIRED — no default — so each test states which
 *    binary it intends.
 *  - `airdrop`, `generateKeypair` — fund test signers with SOL.
 *  - SPL Token-account buffer surgery: `setupUsdcMint`, `createTokenAccount`,
 *    `setTokenDelegate`, `clearTokenDelegate`, `mintTokensToAccount`,
 *    `getTokenBalance`. These mock SPL Token state by writing the canonical
 *    82-byte Mint / 165-byte Account layouts directly via `svm.setAccount` —
 *    no SPL Token CPI in the test harness (V1 pattern).
 *  - `advanceClock(svm, deltaSeconds)` — read-modify-write the Clock sysvar
 *    to advance `unix_timestamp`. Slot is NOT auto-bumped; if a handler
 *    reads slot semantics (V2 doesn't) call `advanceSlots` separately.
 *  - `getAccountData`, `readU64`, `readI64`, `readU16` — raw account
 *    inspection (state decoders live in `@q3labs/pact-protocol-v2-client`).
 *
 * SPL Token Program is built into LiteSVM by default — `create_pool`'s
 * `InitializeAccount3` CPI works against a fresh `new LiteSVM()` with no
 * `addProgramFromFile` call. Token-2022 is NOT built-in; not used here.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { LiteSVM, ComputeBudget, Clock } from "litesvm";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  PROGRAM_ID,
  USDC_MINT_DEVNET,
} from "@q3labs/pact-protocol-v2-client";

// ---------------------------------------------------------------------------
// Program loading
// ---------------------------------------------------------------------------

/**
 * Resolve the path to a built `.so` artifact. Two variants exist:
 *  - `pact_network_v2_pinocchio.so` — built with
 *    `--features bpf-entrypoint,unsafe-bypass-deployer`. Used by the
 *    happy-path + most attack tests. The C-01 deployer guard is disabled.
 *  - `pact_network_v2_pinocchio_no_bypass.so` — built with
 *    `--features bpf-entrypoint` (no bypass). Used by
 *    `11-c01-deployer-guard.test.ts`. The build script copies the cargo
 *    output to this name; see `README.md` for the runbook.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SO_DIR = path.resolve(HERE, "../../../target/deploy");
const SO_BYPASS_PATH = path.join(SO_DIR, "pact_network_v2_pinocchio.so");
const SO_NO_BYPASS_PATH = path.join(SO_DIR, "pact_network_v2_pinocchio_no_bypass.so");

export interface LoadProgramOpts {
  /** Which `.so` variant to load. No default — every test must state intent. */
  bypass: boolean;
  /** Optional clock override. Defaults to current wall-clock time. */
  unixTimestamp?: bigint;
  /** Optional CU budget override. Defaults to 1.4M (Solana cluster cap). */
  computeUnitLimit?: bigint;
}

export function loadProgram(svm: LiteSVM, opts: LoadProgramOpts): void {
  const ts = opts.unixTimestamp ?? BigInt(Math.floor(Date.now() / 1000));
  svm.setClock(new Clock(0n, ts, 0n, 1n, ts));

  const budget = new ComputeBudget();
  budget.computeUnitLimit = opts.computeUnitLimit ?? 1_400_000n;
  svm.withComputeBudget(budget);

  const soPath = opts.bypass ? SO_BYPASS_PATH : SO_NO_BYPASS_PATH;
  svm.addProgramFromFile(PROGRAM_ID, soPath);
}

/**
 * Advance the LiteSVM Clock by `deltaSeconds`. Read-modify-write; slot is
 * NOT bumped (independent field). Safe to call multiple times across
 * transactions.
 *
 * **Ordering trap** (`deposit.rs:274-279`): `deposit` reads `Clock::get()`
 * AFTER the SPL Transfer CPI, so `position.deposit_timestamp` is the
 * post-call timestamp. Call this BETWEEN deposit and withdraw, never
 * before deposit, when testing cooldowns.
 */
export function advanceClock(svm: LiteSVM, deltaSeconds: bigint): void {
  const cur = svm.getClock();
  svm.setClock(
    new Clock(
      cur.slot,
      cur.epochStartTimestamp,
      cur.epoch,
      cur.leaderScheduleEpoch,
      cur.unixTimestamp + deltaSeconds
    )
  );
}

// ---------------------------------------------------------------------------
// SOL airdrop
// ---------------------------------------------------------------------------

export function airdrop(
  svm: LiteSVM,
  pubkey: PublicKey,
  lamports: bigint = 10_000_000_000n
): void {
  // Mirror V1's pattern: directly seed a SystemProgram-owned empty account.
  // `svm.setAccount` expects web3.js `AccountInfo<Uint8Array>` where
  // `lamports: number` — cast safely since airdrop amounts stay well below
  // Number.MAX_SAFE_INTEGER.
  svm.setAccount(pubkey, {
    lamports: Number(lamports),
    data: new Uint8Array(0),
    owner: SystemProgram.programId,
    executable: false,
  });
}

export function generateKeypair(
  svm: LiteSVM,
  lamports: bigint = 10_000_000_000n
): Keypair {
  const kp = Keypair.generate();
  airdrop(svm, kp.publicKey, lamports);
  return kp;
}

// ---------------------------------------------------------------------------
// SPL Token-account buffer surgery (V1 pattern, byte offsets unchanged)
//
// SPL Token Account layout (165 bytes):
//   offset  0..32   mint
//   offset 32..64   owner
//   offset 64..72   amount (u64 LE)
//   offset 72..76   delegate option (u32 LE; 0 = None, 1 = Some)
//   offset 76..108  delegate pubkey (only valid when option == 1)
//   offset 108      state (1 = Initialized, 0 = Uninitialized, 2 = Frozen)
//   offset 109..121 is_native option + payload (None for fungible tokens)
//   offset 121..129 delegated_amount (u64 LE; only valid when option == 1)
//   offset 129..165 close_authority option + payload
//
// Mint layout (82 bytes):
//   offset  0..4    mint_authority option (u32 LE; Some = 1)
//   offset  4..36   mint_authority pubkey
//   offset 36..44   supply (u64 LE)
//   offset 44       decimals
//   offset 45       is_initialized
//   offset 46..50   freeze_authority option + payload
// ---------------------------------------------------------------------------

/**
 * Seed the canonical USDC mint at `USDC_MINT_DEVNET`. The V2 program
 * checks `pool_usdc_mint.address() == config.usdc_mint`, NOT mint-owner ==
 * TOKEN_PROGRAM_ID, but the SPL Token `InitializeAccount3` CPI inside
 * `create_pool` does verify ownership — so the mint must be Token-owned.
 */
export function setupUsdcMint(svm: LiteSVM, mintAuthority: Keypair): PublicKey {
  const mintData = new Uint8Array(82);
  const view = new DataView(mintData.buffer);
  view.setUint32(0, 1, true); // mint_authority Option::Some
  mintData.set(mintAuthority.publicKey.toBytes(), 4);
  mintData[44] = 6; // decimals
  mintData[45] = 1; // is_initialized

  svm.setAccount(USDC_MINT_DEVNET, {
    lamports: 1_000_000_000,
    data: mintData,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });
  return USDC_MINT_DEVNET;
}

function makeTokenAccountData(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint = 0n
): Uint8Array {
  const data = new Uint8Array(165);
  data.set(mint.toBytes(), 0);
  data.set(owner.toBytes(), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  // state = Initialized (critical — V2 ownership guards in deposit /
  // settle_premium / withdraw / submit_claim treat uninitialized accounts
  // as program-data-corrupted; H-1 from critique).
  data[108] = 1;
  return data;
}

export function createTokenAccount(
  svm: LiteSVM,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint = 0n
): PublicKey {
  const kp = Keypair.generate();
  svm.setAccount(kp.publicKey, {
    lamports: 2_039_280, // SPL Token rent-exemption (matches V1)
    data: makeTokenAccountData(mint, owner, amount),
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });
  return kp.publicKey;
}

/**
 * Mimics SPL Token `Approve`: sets the delegate option to Some + writes
 * the delegate pubkey + delegated_amount. Bypasses the Approve CPI
 * because V2 handlers only ever READ delegate fields at fixed offsets;
 * they never re-check the on-chain signature path. Matches V1's pattern.
 */
export function setTokenDelegate(
  svm: LiteSVM,
  tokenAccount: PublicKey,
  delegate: PublicKey,
  amount: bigint
): void {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) throw new Error(`token account not found: ${tokenAccount.toBase58()}`);
  const data = new Uint8Array(acct.data);
  const view = new DataView(data.buffer);
  view.setUint32(72, 1, true); // Option::Some
  data.set(delegate.toBytes(), 76);
  view.setBigUint64(121, amount, true);
  svm.setAccount(tokenAccount, { ...acct, data });
}

/** Mimics SPL Token `Revoke`: zero the delegate option + pubkey + amount. */
export function clearTokenDelegate(svm: LiteSVM, tokenAccount: PublicKey): void {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) throw new Error(`token account not found: ${tokenAccount.toBase58()}`);
  const data = new Uint8Array(acct.data);
  const view = new DataView(data.buffer);
  view.setUint32(72, 0, true);
  for (let i = 76; i < 108; i++) data[i] = 0;
  view.setBigUint64(121, 0n, true);
  svm.setAccount(tokenAccount, { ...acct, data });
}

export function mintTokensToAccount(
  svm: LiteSVM,
  tokenAccount: PublicKey,
  amount: bigint
): void {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) throw new Error(`token account not found: ${tokenAccount.toBase58()}`);
  const data = new Uint8Array(acct.data);
  const view = new DataView(data.buffer);
  const cur = view.getBigUint64(64, true);
  view.setBigUint64(64, cur + amount, true);
  svm.setAccount(tokenAccount, { ...acct, data });
}

export function getTokenBalance(svm: LiteSVM, tokenAccount: PublicKey): bigint {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) return 0n;
  return new DataView(new Uint8Array(acct.data).buffer).getBigUint64(64, true);
}

export function getTokenDelegate(
  svm: LiteSVM,
  tokenAccount: PublicKey
): { delegate: PublicKey | null; amount: bigint } {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) return { delegate: null, amount: 0n };
  const data = new Uint8Array(acct.data);
  const view = new DataView(data.buffer);
  const opt = view.getUint32(72, true);
  if (opt === 0) return { delegate: null, amount: 0n };
  return {
    delegate: new PublicKey(data.slice(76, 108)),
    amount: view.getBigUint64(121, true),
  };
}

// ---------------------------------------------------------------------------
// Raw account inspection (typed decoders live in @q3labs/pact-protocol-v2-client)
// ---------------------------------------------------------------------------

export function getAccountData(svm: LiteSVM, pubkey: PublicKey): Uint8Array | null {
  const acct = svm.getAccount(pubkey);
  return acct ? new Uint8Array(acct.data) : null;
}

export function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer).getBigUint64(offset, true);
}

export function readI64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer).getBigInt64(offset, true);
}

export function readU16(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer).getUint16(offset, true);
}

export function readU8(data: Uint8Array, offset: number): number {
  return data[offset];
}

// ---------------------------------------------------------------------------
// Transaction error introspection
// ---------------------------------------------------------------------------

/**
 * Extract the numeric `Custom(code)` from a LiteSVM `FailedTransactionMetadata`.
 * LiteSVM 0.6.x: `result.err()` returns an opaque `{}` from JS, but
 * `String(result)` (toString) embeds the Rust debug repr including the
 * `Custom(code)` token and the `custom program error: 0xHEX` log line.
 *
 * Strategy: stringify the whole result and grep for `Custom(<digits>)` first,
 * falling back to the hex `0xHEX` in the logs.
 */
export function extractCustomCode(err: unknown): number | undefined {
  if (!err) return undefined;
  const s = String(err);
  // Primary: `Custom(6030)` in the Rust debug repr.
  let m = s.match(/Custom\((\d+)\)/);
  if (m) return Number(m[1]);
  // Fallback: `custom program error: 0xHEX` in program logs.
  m = s.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (m) return parseInt(m[1], 16);
  return undefined;
}

/**
 * Convenience: send a tx + return:
 *  - `undefined` on success
 *  - a `number` for V2 Custom(code) errors (6000..=6030)
 *  - `"non-custom-failure"` for built-in errors (AlreadyProcessed,
 *    AccountAlreadyInitialized, InvalidSeeds, MissingRequiredSignature, etc.)
 *
 * Calls `svm.expireBlockhash()` before every send so back-to-back
 * structurally-identical txs don't get rejected as duplicates (the canonical
 * LiteSVM trap for repeated negative-path tests).
 */
export type TxOutcome = undefined | number | "non-custom-failure";

export function sendAndExtractCode(
  svm: LiteSVM,
  tx: import("@solana/web3.js").Transaction,
  payer: Keypair,
  extraSigners: Keypair[] = []
): TxOutcome {
  svm.expireBlockhash();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer, ...extraSigners);
  const result = svm.sendTransaction(tx);
  if (
    result &&
    typeof result === "object" &&
    result.constructor?.name === "FailedTransactionMetadata"
  ) {
    const code = extractCustomCode(result);
    return code === undefined ? "non-custom-failure" : code;
  }
  return undefined;
}

/** Boolean variant for tests that just need "did it fail at all?". */
export function didFail(outcome: TxOutcome): boolean {
  return outcome !== undefined;
}

// Re-export so test files don't need separate web3.js imports for the basics.
export { PROGRAM_ID, USDC_MINT_DEVNET, TOKEN_PROGRAM_ID, SystemProgram };
