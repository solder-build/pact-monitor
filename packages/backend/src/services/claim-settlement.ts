import { PublicKey, SystemProgram, type TransactionSignature } from "@solana/web3.js";
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

  // Claim PDA seed is sha256(call_id) — the call_id can be any string up to
  // MAX_CALL_ID_LEN (64 chars). Pass the canonical UUID through unchanged so
  // DB <-> on-chain cross-reference is trivial.
  const [claimPda] = deriveClaimPda(programId, policyPda, callRecord.id);

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
      callId: callRecord.id,
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
      oracle: (program.provider as any).wallet.publicKey,
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
