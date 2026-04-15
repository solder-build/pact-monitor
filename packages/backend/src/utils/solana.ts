import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import bs58 from "bs58";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the IDL JSON at module load. Using fs.readFileSync keeps us compatible
// with the repo's ES2022/bundler tsconfig without relying on import-attributes.
const idlJsonPath = join(__dirname, "..", "idl", "pact_insurance.json");
const idl = JSON.parse(fs.readFileSync(idlJsonPath, "utf-8"));

export interface SolanaConfig {
  rpcUrl: string;
  programId: string;
  oracleKeypairPath?: string;
  oracleKeypairBase58?: string;
  treasuryPubkey?: string;
  usdcMint: string;
}

// Module-scope cache so we parse/decode the oracle keypair once per process.
// The backend has exactly one oracle identity, so a simple singleton is enough.
// Tests can wipe it via __resetOracleKeypairCacheForTests().
let cachedOracleKeypair: Keypair | null = null;

export function loadOracleKeypair(config: SolanaConfig): Keypair {
  if (cachedOracleKeypair) return cachedOracleKeypair;

  // Base58 is the Cloud Run / managed-env form: a single string that can live
  // directly in a secret manager entry or env var. Checked first so hosted
  // envs never accidentally fall through to a filesystem path they don't have.
  if (config.oracleKeypairBase58) {
    cachedOracleKeypair = Keypair.fromSecretKey(bs58.decode(config.oracleKeypairBase58));
    return cachedOracleKeypair;
  }

  if (config.oracleKeypairPath) {
    const resolved = config.oracleKeypairPath.startsWith("~")
      ? config.oracleKeypairPath.replace(/^~/, process.env.HOME ?? "")
      : config.oracleKeypairPath;
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((b) => typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 255)
    ) {
      throw new Error(
        `Invalid keypair file at ${resolved}: expected JSON array of 64 bytes (0-255)`,
      );
    }
    cachedOracleKeypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
    return cachedOracleKeypair;
  }

  throw new Error(
    "No oracle keypair configured: set ORACLE_KEYPAIR_BASE58 (preferred for Cloud Run) or ORACLE_KEYPAIR_PATH",
  );
}

// Exposed for tests only.
export function __resetOracleKeypairCacheForTests(): void {
  cachedOracleKeypair = null;
}

export function createSolanaClient(config: SolanaConfig) {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const oracleKeypair = loadOracleKeypair(config);
  const wallet = new Wallet(oracleKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const programId = new PublicKey(config.programId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(idl as any, provider);
  return { connection, provider, program, oracleKeypair, programId };
}

export function deriveProtocolPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId);
}

export function derivePoolPda(programId: PublicKey, hostname: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(hostname)],
    programId,
  );
}

export function deriveVaultPda(programId: PublicKey, poolPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    programId,
  );
}

export function derivePolicyPda(
  programId: PublicKey,
  poolPda: PublicKey,
  agentPubkey: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), poolPda.toBuffer(), agentPubkey.toBuffer()],
    programId,
  );
}

// Exposed so tests can lock in the on-chain seed format.
export function callIdSeedBytes(callId: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(callId).digest());
}

export function deriveClaimPda(
  programId: PublicKey,
  policyPda: PublicKey,
  callId: string,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), policyPda.toBuffer(), callIdSeedBytes(callId)],
    programId,
  );
}

export function getSolanaConfig(): SolanaConfig {
  const programId = process.env.SOLANA_PROGRAM_ID;
  if (!programId) {
    throw new Error("SOLANA_PROGRAM_ID env var not set");
  }
  const usdcMint = process.env.USDC_MINT;
  if (!usdcMint) {
    throw new Error("USDC_MINT env var not set");
  }
  return {
    rpcUrl: process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899",
    programId,
    oracleKeypairPath: process.env.ORACLE_KEYPAIR_PATH,
    oracleKeypairBase58: process.env.ORACLE_KEYPAIR_BASE58,
    treasuryPubkey: process.env.TREASURY_PUBKEY,
    usdcMint,
  };
}
