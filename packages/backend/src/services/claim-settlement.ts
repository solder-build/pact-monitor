import { PublicKey, type TransactionSignature } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createHash } from "crypto";
import { address } from "@solana/kit";
import { generated } from "@pact-network/insurance";
const {
  decodeProtocolConfig,
  decodeClaim,
  findProtocolConfigPda,
  findCoveragePoolPda,
  findCoveragePoolVaultPda,
  findPolicyPda,
  findClaimPda,
  getSubmitClaimInstruction,
  TriggerType,
} = generated;
import {
  createKitSolanaClient,
  getSolanaConfig,
} from "../utils/solana.js";
import {
  kitFetchAccountBytes,
  kitSendTx,
} from "../utils/kit-rpc.js";

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

const triggerTypeMap: Record<string, number> = {
  timeout: TriggerType.Timeout,
  error: TriggerType.Error,
  schema_mismatch: TriggerType.SchemaMismatch,
  latency_sla: TriggerType.LatencySla,
};

export async function submitClaimOnChain(
  callRecord: CallRecord,
  providerHostname: string,
): Promise<ClaimSubmissionResult> {
  if (!callRecord.agent_pubkey) {
    throw new Error("Cannot submit on-chain claim: agent_pubkey missing from call record");
  }

  const config = getSolanaConfig();
  const client = await createKitSolanaClient(config);

  const [protocolConfigAddr] = await findProtocolConfigPda();
  const [poolAddr] = await findCoveragePoolPda(providerHostname);
  const [vaultAddr] = await findCoveragePoolVaultPda(poolAddr);
  const agentAddr = address(callRecord.agent_pubkey);
  const [policyAddr] = await findPolicyPda(poolAddr, agentAddr);

  const callIdHash = Uint8Array.from(
    createHash("sha256").update(callRecord.id).digest(),
  );
  const [claimAddr] = await findClaimPda(policyAddr, callIdHash);

  const configBytes = await kitFetchAccountBytes(client, protocolConfigAddr as string);
  if (!configBytes) throw new Error("Protocol config account not found");
  const protocolConfig = decodeProtocolConfig(configBytes);

  const agentPubkeyWeb3 = new PublicKey(callRecord.agent_pubkey);
  const usdcMintPk = new PublicKey(protocolConfig.usdcMint as string);
  const agentTokenAccount = getAssociatedTokenAddressSync(usdcMintPk, agentPubkeyWeb3);
  const agentTokenAccountAddr = address(agentTokenAccount.toBase58());

  const triggerType = triggerTypeMap[callRecord.classification];
  if (triggerType === undefined) {
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
  const evidenceHash = Uint8Array.from(createHash("sha256").update(evidenceRaw).digest());
  const callTimestamp = BigInt(Math.floor(callRecord.created_at.getTime() / 1000));

  const ix = getSubmitClaimInstruction({
    config: protocolConfigAddr,
    pool: poolAddr,
    vault: vaultAddr,
    policy: policyAddr,
    claim: claimAddr,
    agentTokenAccount: agentTokenAccountAddr,
    oracle: client.oracleSigner,
    args: {
      callId: callRecord.id,
      triggerType,
      evidenceHash,
      callTimestamp,
      latencyMs: callRecord.latency_ms,
      statusCode: callRecord.status_code,
      paymentAmount: BigInt(callRecord.payment_amount),
    },
  });

  const sig = await kitSendTx(client, [ix]);

  // Fetch post-tx state to extract refundAmount.
  const claimBytes = await kitFetchAccountBytes(client, claimAddr as string);
  if (!claimBytes) throw new Error("Claim account not found after submit");
  const claim = decodeClaim(claimBytes);

  // Resolve slot from RPC.
  const txInfo = await (client.rpc as unknown as {
    getTransaction: (
      sig: string,
      opts: { commitment: string; maxSupportedTransactionVersion: number },
    ) => { send: () => Promise<{ slot?: number } | null> };
  })
    .getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    .send();

  return {
    signature: sig,
    slot: txInfo?.slot ?? 0,
    refundAmount: Number(claim.refundAmount),
    claimPda: claimAddr as string,
  };
}

export async function hasActiveOnChainPolicy(
  agentPubkey: string,
  providerHostname: string,
): Promise<boolean> {
  try {
    const config = getSolanaConfig();
    const client = await createKitSolanaClient(config);
    const [poolAddr] = await findCoveragePoolPda(providerHostname);
    const agentAddr = address(agentPubkey);
    const [policyAddr] = await findPolicyPda(poolAddr, agentAddr);

    const { decodePolicy } = generated;
    const policyBytes = await kitFetchAccountBytes(client, policyAddr as string);
    if (!policyBytes) return false;
    const policy = decodePolicy(policyBytes);
    return policy.active !== 0;
  } catch {
    return false;
  }
}
