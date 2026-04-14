import { Keypair, PublicKey, SystemProgram, type TransactionSignature } from "@solana/web3.js";
import { readFileSync } from "fs";
import BN from "bn.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import {
  createSolanaClient,
  deriveProtocolPda,
  derivePoolPda,
  deriveVaultPda,
  derivePolicyPda,
  deriveClaimPda,
  getSolanaConfig,
} from "../utils/solana.js";

let cachedOracleKeypair: Keypair | null = null;

export function getCachedOracleKeypair(): Keypair {
  if (cachedOracleKeypair) return cachedOracleKeypair;
  const path = process.env.PACT_ORACLE_KEYPAIR;
  if (!path) {
    throw new Error("PACT_ORACLE_KEYPAIR env var not set");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((b) => typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    throw new Error(
      `Invalid keypair file at ${path}: expected JSON array of 64 bytes (0-255)`,
    );
  }
  cachedOracleKeypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
  return cachedOracleKeypair;
}

// Exposed for tests only.
export function __resetOracleKeypairCacheForTests(): void {
  cachedOracleKeypair = null;
}

export interface CallRecord {
  id: string;
  agent_id: string;
  agent_pubkey?: string | null;
  api_provider: string;
  payment_amount: number;
  latency_ms: number;
  status_code: number;
  classification: "success" | "timeout" | "error" | "schema_mismatch" | "latency_sla";
  created_at: Date;
}

export interface ClaimSubmissionResult {
  signature: TransactionSignature;
  slot: number;
  refundAmount: number;
  claimPda: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const triggerTypeMap: Record<string, any> = {
  timeout: { timeout: {} },
  error: { error: {} },
  schema_mismatch: { schemaMismatch: {} },
  latency_sla: { latencySla: {} },
};

export async function submitClaimOnChain(
  callRecord: CallRecord,
  providerHostname: string,
): Promise<ClaimSubmissionResult> {
  const { program, programId, connection } = createSolanaClient(getSolanaConfig());

  if (!callRecord.agent_pubkey) {
    throw new Error("Cannot submit on-chain claim: agent_pubkey missing from call record");
  }

  const [protocolPda] = deriveProtocolPda(programId);
  const [poolPda] = derivePoolPda(programId, providerHostname);
  const [vaultPda] = deriveVaultPda(programId, poolPda);
  const agentPubkey = new PublicKey(callRecord.agent_pubkey);
  const [policyPda] = derivePolicyPda(programId, poolPda, agentPubkey);

  // Claim PDA seed must be <= 32 bytes. DB row IDs are UUIDs (36 chars).
  // Strip hyphens -> 32 hex chars -> fits exactly. This transform is
  // deterministic and reversible so DB <-> on-chain cross-reference still works.
  const onChainCallId = callRecord.id.replace(/-/g, "");
  const [claimPda] = deriveClaimPda(programId, policyPda, onChainCallId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = await (program.account as any).protocolConfig.fetch(protocolPda);
  const agentTokenAccount = getAssociatedTokenAddressSync(config.usdcMint, agentPubkey);

  const triggerType = triggerTypeMap[callRecord.classification];
  if (!triggerType) {
    throw new Error(`Invalid classification for claim: ${callRecord.classification}`);
  }

  const evidenceRaw = JSON.stringify({
    id: callRecord.id,
    api_provider: callRecord.api_provider,
    classification: callRecord.classification,
    status_code: callRecord.status_code,
    latency_ms: callRecord.latency_ms,
    payment_amount: callRecord.payment_amount,
  });
  const evidenceHash = Array.from(createHash("sha256").update(evidenceRaw).digest());

  const callTimestamp = Math.floor(callRecord.created_at.getTime() / 1000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sig: string = await (program.methods as any)
    .submitClaim({
      callId: onChainCallId,
      triggerType,
      evidenceHash,
      callTimestamp: new BN(callTimestamp),
      latencyMs: callRecord.latency_ms,
      statusCode: callRecord.status_code,
      paymentAmount: new BN(callRecord.payment_amount),
    })
    .accounts({
      config: protocolPda,
      pool: poolPda,
      vault: vaultPda,
      policy: policyPda,
      claim: claimPda,
      agentTokenAccount,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authority: (program.provider as any).wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const txInfo = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const claim: any = await (program.account as any).claim.fetch(claimPda);

  return {
    signature: sig,
    slot: txInfo?.slot ?? 0,
    refundAmount: claim.refundAmount.toNumber(),
    claimPda: claimPda.toString(),
  };
}

export async function hasActiveOnChainPolicy(
  agentPubkey: string,
  providerHostname: string,
): Promise<boolean> {
  try {
    const { program, programId } = createSolanaClient(getSolanaConfig());
    const [poolPda] = derivePoolPda(programId, providerHostname);
    const [policyPda] = derivePolicyPda(programId, poolPda, new PublicKey(agentPubkey));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const policy: any = await (program.account as any).policy.fetch(policyPda);
    return policy.active;
  } catch {
    return false;
  }
}
