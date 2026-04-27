import { EventEmitter } from "events";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createKitClient,
  kitEnableInsurance,
  kitTopUpDelegation,
  kitGetPolicy,
  kitListPolicies,
  kitEstimateCoverage,
  type KitClient,
} from "./kit-client.js";
import type {
  PactInsuranceConfig,
  PolicyInfo,
  EnableInsuranceArgs,
  TopUpDelegationArgs,
  CoverageEstimate,
  ClaimSubmissionResult,
} from "./types.js";

const LOW_BALANCE_THRESHOLD_BPS = 2000;

export class PactInsurance extends EventEmitter {
  private config: PactInsuranceConfig;
  private agentKeypair: Keypair;
  private cachedClient: KitClient | null = null;
  private lastKnownAllowance: Map<string, bigint> = new Map();

  constructor(config: PactInsuranceConfig, agentKeypair: Keypair) {
    super();
    this.config = config;
    this.agentKeypair = agentKeypair;
  }

  get agentPubkey(): PublicKey {
    return this.agentKeypair.publicKey;
  }

  private async getClient(): Promise<KitClient> {
    if (!this.cachedClient) {
      this.cachedClient = await createKitClient({
        rpcUrl: this.config.rpcUrl,
        programId: this.config.programId,
        agentKeypair: this.agentKeypair,
      });
    }
    return this.cachedClient;
  }

  async enableInsurance(args: EnableInsuranceArgs): Promise<string> {
    const client = await this.getClient();
    const sig = await kitEnableInsurance(client, args);
    this.lastKnownAllowance.set(args.providerHostname, args.allowanceUsdc);
    return sig;
  }

  async topUpDelegation(args: TopUpDelegationArgs): Promise<string> {
    const client = await this.getClient();
    const sig = await kitTopUpDelegation(client, args);
    this.lastKnownAllowance.set(args.providerHostname, args.newTotalAllowanceUsdc);
    return sig;
  }

  async getPolicy(providerHostname: string): Promise<PolicyInfo | null> {
    const client = await this.getClient();
    return kitGetPolicy(client, providerHostname);
  }

  async listPolicies(): Promise<PolicyInfo[]> {
    const client = await this.getClient();
    return kitListPolicies(client);
  }

  async estimateCoverage(
    providerHostname: string,
    usdcAmount: bigint,
  ): Promise<CoverageEstimate> {
    const client = await this.getClient();
    return kitEstimateCoverage(client, providerHostname, usdcAmount);
  }

  async submitClaim(
    providerHostname: string,
    callRecordId: string,
  ): Promise<ClaimSubmissionResult> {
    if (!this.config.backendUrl) {
      throw new Error("backendUrl required to submit claim");
    }
    const trimmedKey = this.config.apiKey?.trim();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (trimmedKey) {
      headers.Authorization = `Bearer ${trimmedKey}`;
    }
    const r = await globalThis.fetch(`${this.config.backendUrl}/api/v1/claims/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ callRecordId, providerHostname }),
    });
    if (!r.ok) {
      throw new Error(
        `Claim submission failed: ${r.status} ${await r.text()}`,
      );
    }
    return (await r.json()) as ClaimSubmissionResult;
  }

  recordCall(providerHostname: string, callCost: bigint): void {
    this.emit("billed", { callCost });
    const last = this.lastKnownAllowance.get(providerHostname);
    if (last !== undefined && last > 0n) {
      const threshold = (last * BigInt(LOW_BALANCE_THRESHOLD_BPS)) / 10_000n;
      if (callCost >= threshold) {
        this.emit("low-balance", { remainingAllowance: last, threshold });
      }
    }
  }
}
