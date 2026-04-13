import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import bs58 from "bs58";

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

export function loadOracleKeypair(config: SolanaConfig): Keypair {
  if (config.oracleKeypairPath) {
    const resolved = config.oracleKeypairPath.startsWith("~")
      ? config.oracleKeypairPath.replace(/^~/, process.env.HOME ?? "")
      : config.oracleKeypairPath;
    const raw = fs.readFileSync(resolved, "utf-8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  if (config.oracleKeypairBase58) {
    return Keypair.fromSecretKey(bs58.decode(config.oracleKeypairBase58));
  }
  throw new Error("No oracle keypair configured");
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

export function deriveClaimPda(
  programId: PublicKey,
  policyPda: PublicKey,
  callId: string,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), policyPda.toBuffer(), Buffer.from(callId)],
    programId,
  );
}

export function getSolanaConfig(): SolanaConfig {
  return {
    rpcUrl: process.env.SOLANA_RPC_URL!,
    programId: process.env.SOLANA_PROGRAM_ID!,
    oracleKeypairPath: process.env.ORACLE_KEYPAIR_PATH,
    oracleKeypairBase58: process.env.ORACLE_KEYPAIR_BASE58,
    treasuryPubkey: process.env.TREASURY_PUBKEY,
    usdcMint: process.env.USDC_MINT!,
  };
}
