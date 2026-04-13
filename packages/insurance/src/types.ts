import { PublicKey } from "@solana/web3.js";

export interface PactInsuranceConfig {
  rpcUrl: string;
  programId: string;
  backendUrl?: string;
}

export interface PolicyInfo {
  pool: PublicKey;
  agent: PublicKey;
  agentTokenAccount: PublicKey;
  agentId: string;
  totalPremiumsPaid: bigint;
  totalClaimsReceived: bigint;
  callsCovered: bigint;
  active: boolean;
  createdAt: bigint;
  expiresAt: bigint;
  delegatedAmount: bigint;
  remainingAllowance: bigint;
}

export interface EnableInsuranceArgs {
  providerHostname: string;
  allowanceUsdc: bigint;
  expiresAt?: bigint;
  agentId?: string;
}

export interface TopUpDelegationArgs {
  providerHostname: string;
  newTotalAllowanceUsdc: bigint;
}

export interface CoverageEstimate {
  rateBps: number;
  estimatedCalls: number;
  perCallPremium: bigint;
}

export interface ClaimSubmissionResult {
  signature: string;
  slot: number;
  refundAmount: number;
}

export interface BilledEvent {
  callCost: bigint;
}

export interface LowBalanceEvent {
  remainingAllowance: bigint;
  threshold: bigint;
}
