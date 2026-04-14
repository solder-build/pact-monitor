import { EventEmitter } from "events";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createApproveInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  createAnchorClient,
  deriveProtocolPda,
  derivePoolPda,
  derivePolicyPda,
  type AnchorClient,
} from "./anchor-client.js";
import type {
  PactInsuranceConfig,
  PolicyInfo,
  EnableInsuranceArgs,
  TopUpDelegationArgs,
  CoverageEstimate,
  ClaimSubmissionResult,
} from "./types.js";

// Emit when remainingAllowance falls below 20% of last-known total
const LOW_BALANCE_THRESHOLD_BPS = 2000;

export class PactInsurance extends EventEmitter {
  private config: PactInsuranceConfig;
  private agentKeypair: Keypair;
  private cachedClient: AnchorClient | null = null;
  private lastKnownAllowance: Map<string, bigint> = new Map();

  constructor(config: PactInsuranceConfig, agentKeypair: Keypair) {
    super();
    this.config = config;
    this.agentKeypair = agentKeypair;
  }

  get agentPubkey(): PublicKey {
    return this.agentKeypair.publicKey;
  }

  private getClient(): AnchorClient {
    if (!this.cachedClient) {
      this.cachedClient = createAnchorClient({
        rpcUrl: this.config.rpcUrl,
        programId: this.config.programId,
        agentKeypair: this.agentKeypair,
      });
    }
    return this.cachedClient;
  }

  async enableInsurance(args: EnableInsuranceArgs): Promise<string> {
    const { program, programId, provider } = this.getClient();

    const [protocolPda] = deriveProtocolPda(programId);
    const [poolPda] = derivePoolPda(programId, args.providerHostname);
    const [policyPda] = derivePolicyPda(
      programId,
      poolPda,
      this.agentKeypair.publicKey,
    );

    const config: any = await (program.account as any).protocolConfig.fetch(
      protocolPda,
    );
    const agentAta = getAssociatedTokenAddressSync(
      config.usdcMint,
      this.agentKeypair.publicKey,
    );

    const approveIx = createApproveInstruction(
      agentAta,
      poolPda,
      this.agentKeypair.publicKey,
      args.allowanceUsdc,
    );

    const enableIx = await (program.methods as any)
      .enableInsurance({
        agentId:
          args.agentId ??
          this.agentKeypair.publicKey.toBase58().slice(0, 16),
        expiresAt: new BN((args.expiresAt ?? 0n).toString()),
      })
      .accounts({
        config: protocolPda,
        pool: poolPda,
        policy: policyPda,
        agentTokenAccount: agentAta,
        agent: this.agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(approveIx).add(enableIx);
    const sig = await provider.sendAndConfirm(tx, [this.agentKeypair]);
    this.lastKnownAllowance.set(args.providerHostname, args.allowanceUsdc);
    return sig;
  }

  async topUpDelegation(args: TopUpDelegationArgs): Promise<string> {
    const { program, programId, provider } = this.getClient();
    const [protocolPda] = deriveProtocolPda(programId);

    const config: any = await (program.account as any).protocolConfig.fetch(
      protocolPda,
    );
    const agentAta = getAssociatedTokenAddressSync(
      config.usdcMint,
      this.agentKeypair.publicKey,
    );
    const [poolPda] = derivePoolPda(programId, args.providerHostname);

    const approveIx = createApproveInstruction(
      agentAta,
      poolPda,
      this.agentKeypair.publicKey,
      args.newTotalAllowanceUsdc,
    );

    const tx = new Transaction().add(approveIx);
    const sig = await provider.sendAndConfirm(tx, [this.agentKeypair]);
    this.lastKnownAllowance.set(
      args.providerHostname,
      args.newTotalAllowanceUsdc,
    );
    return sig;
  }

  async getPolicy(providerHostname: string): Promise<PolicyInfo | null> {
    const { program, programId, connection } = this.getClient();
    const [poolPda] = derivePoolPda(programId, providerHostname);
    const [policyPda] = derivePolicyPda(
      programId,
      poolPda,
      this.agentKeypair.publicKey,
    );

    let policy: any;
    try {
      policy = await (program.account as any).policy.fetch(policyPda);
    } catch {
      return null;
    }

    let delegatedAmount = 0n;
    try {
      const tokenAccount = await getAccount(connection, policy.agentTokenAccount);
      delegatedAmount = tokenAccount.delegatedAmount;
    } catch {
      // best-effort: leave at 0n
    }

    return {
      pool: policy.pool,
      agent: policy.agent,
      agentTokenAccount: policy.agentTokenAccount,
      agentId: policy.agentId,
      totalPremiumsPaid: BigInt(policy.totalPremiumsPaid.toString()),
      totalClaimsReceived: BigInt(policy.totalClaimsReceived.toString()),
      callsCovered: BigInt(policy.callsCovered.toString()),
      active: policy.active,
      createdAt: BigInt(policy.createdAt.toString()),
      expiresAt: BigInt(policy.expiresAt.toString()),
      delegatedAmount,
      remainingAllowance: delegatedAmount,
    };
  }

  async listPolicies(): Promise<PolicyInfo[]> {
    const { program, connection } = this.getClient();
    const policies = await (program.account as any).policy.all([
      {
        memcmp: {
          offset: 8,
          bytes: this.agentKeypair.publicKey.toBase58(),
        },
      },
    ]);
    const out: PolicyInfo[] = [];
    for (const p of policies) {
      let delegatedAmount = 0n;
      try {
        const ta = await getAccount(connection, p.account.agentTokenAccount);
        delegatedAmount = ta.delegatedAmount;
      } catch {
        // best-effort
      }
      out.push({
        pool: p.account.pool,
        agent: p.account.agent,
        agentTokenAccount: p.account.agentTokenAccount,
        agentId: p.account.agentId,
        totalPremiumsPaid: BigInt(p.account.totalPremiumsPaid.toString()),
        totalClaimsReceived: BigInt(p.account.totalClaimsReceived.toString()),
        callsCovered: BigInt(p.account.callsCovered.toString()),
        active: p.account.active,
        createdAt: BigInt(p.account.createdAt.toString()),
        expiresAt: BigInt(p.account.expiresAt.toString()),
        delegatedAmount,
        remainingAllowance: delegatedAmount,
      });
    }
    return out;
  }

  async estimateCoverage(
    providerHostname: string,
    usdcAmount: bigint,
  ): Promise<CoverageEstimate> {
    const { program, programId } = this.getClient();
    const [poolPda] = derivePoolPda(programId, providerHostname);
    const pool: any = await (program.account as any).coveragePool.fetch(poolPda);
    const rateBps: number = pool.insuranceRateBps;
    const perCallPremium = (usdcAmount * BigInt(rateBps)) / 10_000n;
    const estimatedCalls =
      perCallPremium > 0n ? Number(usdcAmount / perCallPremium) : 0;
    return { rateBps, estimatedCalls, perCallPremium };
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

  // Internal: emit billing/low-balance events. Called from monitor SDK if bound.
  recordCall(providerHostname: string, callCost: bigint): void {
    this.emit("billed", { callCost });
    const last = this.lastKnownAllowance.get(providerHostname);
    if (last !== undefined && last > 0n) {
      const threshold = (last * BigInt(LOW_BALANCE_THRESHOLD_BPS)) / 10_000n;
      // Best-effort low-balance signal (no persistence; one-shot per process)
      if (callCost >= threshold) {
        this.emit("low-balance", { remainingAllowance: last, threshold });
      }
    }
  }
}
