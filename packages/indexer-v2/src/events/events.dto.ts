// Wire shapes posted by settler-v2's IndexerPusherService. Bigint-as-string
// throughout so JSON round-trips without precision loss.

export interface SettlePremiumCallDto {
  callId: string;
  callIdHash: string;        // 64-char sha256 hex
  agentPubkey: string;
  policyPda: string;
  callValue: string;
  poolCut: string;
  treasuryCut: string;
  referrerCut: string;
}

export interface SettlePremiumEventDto {
  signature: string;
  ts: string;
  calls: SettlePremiumCallDto[];
}

export interface SubmitClaimDto {
  callId: string;
  callIdHash: string;
  claimPda: string;
  policyPda: string;
  pool: string;
  agentPubkey: string;
  paymentAmount: string;
  refundAmount: string;
  evidenceHash: string;
  statusCode: number;
  latencyMs: number;
  /** 0..=3, mirrors TriggerType enum. */
  triggerType: number;
  callTimestamp: string;
}

export interface SubmitClaimEventDto {
  signature: string;
  ts: string;
  claim: SubmitClaimDto;
}
