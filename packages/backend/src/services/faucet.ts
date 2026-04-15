import {
  Connection,
  PublicKey,
  type TransactionSignature,
} from "@solana/web3.js";
import {
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import {
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getSolanaConfig, loadFaucetKeypair } from "../utils/solana.js";
import { getCachedNetwork, isMainnet } from "../utils/network.js";
import { query } from "../db.js";

// Max drip per request. Server-authoritative — the client is allowed to pick
// amount within [1, MAX] but any request outside the window is a 400. Keeps
// abuse bounded even if rate-limit plugin ever gets bypassed (e.g. restart
// wipes the in-memory window).
export const MAX_DRIP_USDC = 10_000;
export const MIN_DRIP_USDC = 1;

// USDC has 6 decimals; 1 whole USDC = 1_000_000 base units.
const USDC_DECIMALS = 6;

export class FaucetDisabledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FaucetDisabledError";
  }
}

export class InvalidRecipientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecipientError";
  }
}

export class AmountOutOfRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountOutOfRangeError";
  }
}

export interface DripResult {
  signature: TransactionSignature;
  amount: number; // whole USDC
  recipient: string;
  ata: string;
  network: string;
  explorer: string;
}

export interface FaucetStatus {
  enabled: boolean;
  network: string;
  maxPerDrip: number;
  minPerDrip: number;
  mint: string;
  reason?: string;
}

// Resolves once what the /status endpoint should return. Cheap enough to call
// on every request — no caching beyond what the underlying helpers already do.
export function getFaucetStatus(): FaucetStatus {
  const network = getCachedNetwork();
  const config = getSolanaConfig();

  // Faucet is devnet/localnet only. Any other network (mainnet, testnet,
  // unknown) returns enabled:false with an explicit reason so the client can
  // show something useful.
  if (network === "mainnet-beta") {
    return {
      enabled: false,
      network,
      maxPerDrip: MAX_DRIP_USDC,
      minPerDrip: MIN_DRIP_USDC,
      mint: config.usdcMint,
      reason: "Faucet is devnet-only and cannot mint on mainnet-beta",
    };
  }
  if (network === "testnet") {
    return {
      enabled: false,
      network,
      maxPerDrip: MAX_DRIP_USDC,
      minPerDrip: MIN_DRIP_USDC,
      mint: config.usdcMint,
      reason: "Faucet is devnet-only — this backend is pointed at testnet",
    };
  }
  if (network === "unknown") {
    return {
      enabled: false,
      network,
      maxPerDrip: MAX_DRIP_USDC,
      minPerDrip: MIN_DRIP_USDC,
      mint: config.usdcMint,
      reason: "Network detection failed; faucet disabled as a safety default",
    };
  }

  // Fail closed if the faucet keypair env is unset — makes the common "I
  // forgot to set FAUCET_KEYPAIR_*" misconfiguration return a clear status
  // message instead of a 500 at drip time.
  if (!config.faucetKeypairBase58 && !config.faucetKeypairPath) {
    return {
      enabled: false,
      network,
      maxPerDrip: MAX_DRIP_USDC,
      minPerDrip: MIN_DRIP_USDC,
      mint: config.usdcMint,
      reason: "FAUCET_KEYPAIR_BASE58 / FAUCET_KEYPAIR_PATH is not configured",
    };
  }

  return {
    enabled: true,
    network,
    maxPerDrip: MAX_DRIP_USDC,
    minPerDrip: MIN_DRIP_USDC,
    mint: config.usdcMint,
  };
}

// Exported for direct unit testing of the pure validation rules.
export function validateRecipient(raw: string): PublicKey {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new InvalidRecipientError("recipient is required");
  }
  try {
    const pk = new PublicKey(raw);
    // PublicKey accepts 32-byte arrays too; guard the string form explicitly.
    if (!PublicKey.isOnCurve(pk.toBytes())) {
      throw new InvalidRecipientError(
        "recipient must be a wallet address (on-curve ed25519 pubkey), not a PDA",
      );
    }
    return pk;
  } catch (err) {
    if (err instanceof InvalidRecipientError) throw err;
    throw new InvalidRecipientError(`recipient is not a valid base58 pubkey: ${(err as Error).message}`);
  }
}

// Exported for direct unit testing of the pure validation rules.
export function validateAmount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new AmountOutOfRangeError("amount must be a positive integer (whole USDC)");
  }
  if (raw < MIN_DRIP_USDC || raw > MAX_DRIP_USDC) {
    throw new AmountOutOfRangeError(
      `amount must be between ${MIN_DRIP_USDC} and ${MAX_DRIP_USDC} whole USDC`,
    );
  }
  return raw;
}

export interface DripArgs {
  recipient: string;
  amount: number;
  ip?: string;
}

export async function dripUsdc(args: DripArgs): Promise<DripResult> {
  // Mainnet/unknown network gate. Doing the check here and not just in the
  // route handler guarantees a service-level caller (script, test, future
  // route) can't sidestep the lockout.
  if (isMainnet() || getCachedNetwork() === "unknown") {
    throw new FaucetDisabledError(
      "Faucet disabled on this network (mainnet or unknown). Drip refused.",
    );
  }

  const recipientPk = validateRecipient(args.recipient);
  const amount = validateAmount(args.amount);

  const config = getSolanaConfig();
  const faucetKeypair = loadFaucetKeypair(config);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const mint = new PublicKey(config.usdcMint);

  // Ensure the recipient has a token account for this mint; create it (paid
  // by the faucet) if they don't. The faucet eats the ~0.002 SOL rent so first
  // -time users don't need SOL to claim USDC. Idempotent.
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    faucetKeypair,
    mint,
    recipientPk,
  );

  // Convert whole USDC → base units (6 decimals). BigInt is required because
  // 10_000 * 1_000_000 overflows safe integer math only at ~9 trillion — but
  // spl-token's typings expect bigint | number anyway.
  const baseUnits = BigInt(amount) * BigInt(10 ** USDC_DECIMALS);

  const mintIx = createMintToInstruction(
    mint,
    recipientAta.address,
    faucetKeypair.publicKey,
    baseUnits,
  );

  const tx = new Transaction().add(mintIx);
  const signature = await sendAndConfirmTransaction(connection, tx, [faucetKeypair], {
    commitment: "confirmed",
  });

  const network = getCachedNetwork();

  // Audit row — no uniqueness, no enforcement. Purely for "who got what" on
  // the devnet mint so we can retrospectively notice abuse patterns.
  await query(
    `INSERT INTO faucet_drips (recipient, amount, signature, network, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      recipientPk.toBase58(),
      String(baseUnits),
      signature,
      network,
      args.ip ?? null,
    ],
  );

  const explorerCluster = network === "devnet" ? "?cluster=devnet" : "";
  const explorer = `https://explorer.solana.com/tx/${signature}${explorerCluster}`;

  return {
    signature,
    amount,
    recipient: recipientPk.toBase58(),
    ata: recipientAta.address.toBase58(),
    network,
    explorer,
  };
}

// Exposed for tests so they can call into the service without going through
// the route handler. Returns the ATA even if it already existed.
export async function __peekRecipientAtaForTests(recipient: string): Promise<string> {
  const pk = new PublicKey(recipient);
  const config = getSolanaConfig();
  const ata = getAssociatedTokenAddressSync(new PublicKey(config.usdcMint), pk);
  return ata.toBase58();
}
