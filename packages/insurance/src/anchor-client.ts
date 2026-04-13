import * as fs from "fs";
import { fileURLToPath } from "url";
import * as path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const idlPath = path.resolve(__dirname, "../idl/pact_insurance.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

export interface AnchorClientOptions {
  rpcUrl: string;
  programId: string;
  agentKeypair: Keypair;
}

export interface AnchorClient {
  connection: Connection;
  provider: AnchorProvider;
  program: Program;
  programId: PublicKey;
  agentKeypair: Keypair;
}

export function createAnchorClient(opts: AnchorClientOptions): AnchorClient {
  const connection = new Connection(opts.rpcUrl, "confirmed");
  const wallet = new Wallet(opts.agentKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const programId = new PublicKey(opts.programId);
  const program = new Program(idl, provider);
  return { connection, provider, program, programId, agentKeypair: opts.agentKeypair };
}

export function deriveProtocolPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId);
}

export function derivePoolPda(
  programId: PublicKey,
  hostname: string,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(hostname)],
    programId,
  );
}

export function deriveVaultPda(
  programId: PublicKey,
  poolPda: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    programId,
  );
}

export function derivePolicyPda(
  programId: PublicKey,
  poolPda: PublicKey,
  agent: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), poolPda.toBuffer(), agent.toBuffer()],
    programId,
  );
}
