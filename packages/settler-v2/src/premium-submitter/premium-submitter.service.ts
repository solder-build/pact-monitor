// PremiumSubmitterService — composes N settle_premium ix into one tx,
// submits to RPC, polls signature status, and reports the outcome upstream.
//
// Idempotency contract (Locked decision §settler-v2):
//   1. For each callId in the incoming batch, SELECT V2PremiumAttempt:
//        * status=Confirmed → ack-and-skip (drop from outgoing batch).
//        * any other state → upsert to Pending with attemptCount += 1.
//   2. Build tx, simulate (best-effort logging), send.
//   3. Poll getSignatureStatuses until confirmed or timeout.
//   4. On confirmation: UPDATE all V2PremiumAttempt rows in the batch to
//      Confirmed(signature). Caller acks the messages.
//   5. On failure: UPDATE rows to Failed(error). Caller nacks for redelivery.
//
// Account assembly per ix:
//   shared (same across batch — uniform hostname): configPda, poolPda, vault,
//                                                   treasuryAta, oracleSigner,
//                                                   tokenProgram
//   per-ix: policyPda, agentAta, optional referrerTokenAccount
//
// The hostname → (poolPda, vault, treasuryAta) trio is cached in-process
// with a 60s TTL — pool data only changes via authority ops, much rarer than
// per-call settlements.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  PROGRAM_ID,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  buildSettlePremiumIx,
  decodeCoveragePool,
  decodePolicy,
  decodeProtocolConfig,
  deriveAssociatedTokenAccount,
  getCoveragePoolPda,
  getPolicyPda,
  getProtocolConfigPda,
  getVaultPda,
} from "@q3labs/pact-protocol-v2-client";
import { SecretLoaderService } from "../config/secret-loader.service";
import { SettleBatch } from "../batcher/batcher.service";
import { PrismaService } from "../prisma/prisma.service";

export interface PerCallShare {
  /** Raw call ID (pre-hash). */
  callId: string;
  /** sha256 hex of callId. Stored alongside settlement row + matches Claim. */
  callIdHash: string;
  agentPubkey: string;
  policyPda: string;
  callValue: bigint;
  /** Pool/Treasury/Referrer cuts — derived off-chain from chain state at submit time. */
  poolCut: bigint;
  treasuryCut: bigint;
  referrerCut: bigint;
}

export interface PremiumSubmitOutcome {
  signature: string;
  /** Indexes into the original batch.messages array. */
  acceptedIndexes: number[];
  /** Indexes that were skipped via Confirmed-attempt short-circuit. */
  shortCircuitedIndexes: number[];
  /** Per-call settlement details for downstream indexer push. */
  shares: PerCallShare[];
}

export class BatchSubmitError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "BatchSubmitError";
  }
}

interface PoolCache {
  poolPda: PublicKey;
  vault: PublicKey;
  treasuryAta: PublicKey;
  insuranceRateBps: number;
  minPremiumBps: number;
  expiresAt: number;
}

const POOL_CACHE_TTL_MS = 60_000;

@Injectable()
export class PremiumSubmitterService implements OnModuleDestroy {
  private readonly logger = new Logger(PremiumSubmitterService.name);
  private readonly programId: PublicKey;
  private readonly usdcMint: PublicKey;
  private readonly configPda: PublicKey;
  private readonly cuLimit: number;
  private readonly cuPriceMicroLamports: number;
  private readonly confirmTimeoutMs: number;
  private readonly confirmPollMs: number;
  private readonly poolCache = new Map<string, PoolCache>();
  // Resolved at first need from on-chain ProtocolConfig.
  private treasuryPubkey: PublicKey | null = null;
  private protocolFeeBps = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly connection: Connection,
    private readonly secrets: SecretLoaderService,
    @Optional() private readonly prisma?: PrismaService
  ) {
    this.programId = new PublicKey(this.config.getOrThrow<string>("PROGRAM_ID"));
    const usdc = this.config.get<string>("USDC_MINT");
    this.usdcMint = usdc
      ? new PublicKey(usdc)
      : // Default to devnet USDC for v2 dev/test; mainnet flips USDC_MINT.
        USDC_MINT_DEVNET;
    [this.configPda] = getProtocolConfigPda(this.programId);
    this.cuLimit =
      Number(this.config.get("COMPUTE_UNIT_LIMIT")) || 1_400_000;
    this.cuPriceMicroLamports =
      Number(this.config.get("COMPUTE_UNIT_PRICE_MICROLAMPORTS")) || 5000;
    this.confirmTimeoutMs =
      Number(this.config.get("CONFIRM_TIMEOUT_MS")) || 30_000;
    this.confirmPollMs =
      Number(this.config.get("CONFIRM_POLL_INTERVAL_MS")) || 500;
    // Mainnet flag — only here for the unused-import suppression; mainnet
    // USDC mint is exposed for callers that override.
    void USDC_MINT_MAINNET;
  }

  onModuleDestroy(): void {
    this.poolCache.clear();
  }

  /**
   * Submit one same-hostname batch.
   *
   * Throws BatchSubmitError on permanent failure (caller must nack).
   * Returns outcome with per-call shares on success.
   */
  async submit(batch: SettleBatch): Promise<PremiumSubmitOutcome> {
    if (batch.messages.length === 0) {
      throw new BatchSubmitError("submit called with empty batch");
    }

    const pool = await this.resolvePool(batch.hostname);
    await this.ensureProtocolConfigLoaded();

    // 1) Idempotency precheck.
    const accepted: number[] = [];
    const shortCircuited: number[] = [];
    const callPlans: CallPlan[] = [];

    for (let idx = 0; idx < batch.messages.length; idx++) {
      const m = batch.messages[idx]!;
      const d = m.data as Record<string, unknown>;
      const callId = String(d["callId"] ?? "");
      const agentPubkey = String(d["agentPubkey"] ?? "");
      const policyPdaStr = String(d["policyPda"] ?? "");
      const callValue = BigInt(String(d["callValue"] ?? "0"));

      if (!callId || !agentPubkey || !policyPdaStr || callValue === 0n) {
        // Should already be filtered by batcher; defensive.
        this.logger.warn(
          `Dropping malformed event at idx=${idx}: callId="${callId}"`
        );
        m.ack();
        continue;
      }

      if (this.prisma) {
        const existing = await this.prisma.v2PremiumAttempt.findUnique({
          where: { callId },
        });
        if (existing?.status === "Confirmed") {
          this.logger.debug(
            `Short-circuit: callId=${callId} already Confirmed (sig=${existing.lastAttemptSignature})`
          );
          shortCircuited.push(idx);
          m.ack();
          continue;
        }
        await this.prisma.v2PremiumAttempt.upsert({
          where: { callId },
          update: {
            attemptCount: { increment: 1 },
            status: "Pending",
            policyPda: policyPdaStr,
          },
          create: {
            callId,
            attemptCount: 1,
            status: "Pending",
            policyPda: policyPdaStr,
          },
        });
      }

      const agentPk = new PublicKey(agentPubkey);
      const policyPk = new PublicKey(policyPdaStr);
      const agentAta = deriveAssociatedTokenAccount(agentPk, this.usdcMint);

      // Fetch the policy to surface optional referrer info. One getAccountInfo
      // per call is the simplest correct path; for high-throughput tuning
      // C4+ can cache policies (active-only, short TTL).
      const policyInfo = await this.connection.getAccountInfo(
        policyPk,
        "confirmed"
      );
      let referrerTokenAccount: PublicKey | undefined;
      let referrerShareBps = 0;
      if (policyInfo) {
        const decoded = decodePolicy(policyInfo.data);
        if (decoded.referrerPresent === 1 && decoded.referrer) {
          const referrerPk = new PublicKey(decoded.referrer);
          referrerTokenAccount = deriveAssociatedTokenAccount(
            referrerPk,
            this.usdcMint
          );
          referrerShareBps = decoded.referrerShareBps;
        }
      }

      const split = splitPremium(
        callValue,
        pool.insuranceRateBps,
        pool.minPremiumBps,
        this.protocolFeeBps,
        referrerShareBps
      );

      callPlans.push({
        idx,
        callId,
        agentPubkey,
        policyPda: policyPk,
        agentAta,
        referrerTokenAccount,
        callValue,
        split,
      });
      accepted.push(idx);
    }

    if (callPlans.length === 0) {
      // Everything was short-circuited or malformed; nothing to send.
      return {
        signature: "",
        acceptedIndexes: accepted,
        shortCircuitedIndexes: shortCircuited,
        shares: [],
      };
    }

    // 2) Build tx.
    const oracle = this.secrets.keypair;
    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.cuPriceMicroLamports,
      })
    );
    for (const plan of callPlans) {
      tx.add(
        buildSettlePremiumIx({
          programId: this.programId,
          configPda: this.configPda,
          poolPda: pool.poolPda,
          vault: pool.vault,
          policyPda: plan.policyPda,
          treasuryAta: pool.treasuryAta,
          agentAta: plan.agentAta,
          oracleSigner: oracle.publicKey,
          callValue: plan.callValue,
          referrerTokenAccount: plan.referrerTokenAccount,
        })
      );
    }

    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = oracle.publicKey;
    tx.sign(oracle);

    // 3) Send + confirm.
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
    } catch (err) {
      await this.markFailed(callPlans, (err as Error).message);
      throw new BatchSubmitError(
        `sendRawTransaction failed: ${(err as Error).message}`,
        err
      );
    }

    const confirmed = await this.pollConfirmation(signature);
    if (!confirmed) {
      await this.markFailed(callPlans, `timed out waiting for ${signature}`);
      throw new BatchSubmitError(
        `confirmation timeout for tx ${signature}`
      );
    }

    // 4) Mark Confirmed.
    if (this.prisma) {
      await this.prisma.v2PremiumAttempt.updateMany({
        where: { callId: { in: callPlans.map((p) => p.callId) } },
        data: { status: "Confirmed", lastAttemptSignature: signature },
      });
    }

    // 5) Compute callIdHash for each.
    const { hashCallId } = await import(
      "@q3labs/pact-protocol-v2-client"
    );
    const shares: PerCallShare[] = callPlans.map((p) => ({
      callId: p.callId,
      callIdHash: bytesToHex(hashCallId(p.callId)),
      agentPubkey: p.agentPubkey,
      policyPda: p.policyPda.toBase58(),
      callValue: p.callValue,
      poolCut: p.split.poolCut,
      treasuryCut: p.split.treasuryCut,
      referrerCut: p.split.referrerCut,
    }));

    return {
      signature,
      acceptedIndexes: accepted,
      shortCircuitedIndexes: shortCircuited,
      shares,
    };
  }

  private async pollConfirmation(signature: string): Promise<boolean> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    while (Date.now() < deadline) {
      const statuses = await this.connection.getSignatureStatuses([signature], {
        searchTransactionHistory: false,
      });
      const status = statuses.value[0];
      if (
        status &&
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized")
      ) {
        if (status.err) {
          this.logger.error(
            `Tx ${signature} confirmed with error: ${JSON.stringify(status.err)}`
          );
          return false;
        }
        return true;
      }
      await new Promise((r) => setTimeout(r, this.confirmPollMs));
    }
    return false;
  }

  private async markFailed(
    plans: CallPlan[],
    errorMessage: string
  ): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.v2PremiumAttempt.updateMany({
        where: { callId: { in: plans.map((p) => p.callId) } },
        data: { status: "Failed", errorMessage },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to mark V2PremiumAttempt Failed: ${(err as Error).message}`
      );
    }
  }

  private async resolvePool(hostname: string): Promise<PoolCache> {
    const now = Date.now();
    const cached = this.poolCache.get(hostname);
    if (cached && cached.expiresAt > now) return cached;

    const [poolPda] = getCoveragePoolPda(this.programId, hostname);
    const [vault] = getVaultPda(this.programId, poolPda);
    const poolInfo = await this.connection.getAccountInfo(poolPda, "confirmed");
    if (!poolInfo) {
      throw new BatchSubmitError(
        `pool not found on-chain for hostname=${hostname}`
      );
    }
    const decoded = decodeCoveragePool(poolInfo.data);

    await this.ensureProtocolConfigLoaded();
    if (!this.treasuryPubkey) {
      throw new BatchSubmitError(
        "treasury pubkey not loaded from ProtocolConfig"
      );
    }
    const treasuryAta = deriveAssociatedTokenAccount(
      this.treasuryPubkey,
      this.usdcMint
    );

    const entry: PoolCache = {
      poolPda,
      vault,
      treasuryAta,
      insuranceRateBps: decoded.insuranceRateBps,
      minPremiumBps: decoded.minPremiumBps,
      expiresAt: now + POOL_CACHE_TTL_MS,
    };
    this.poolCache.set(hostname, entry);
    return entry;
  }

  private async ensureProtocolConfigLoaded(): Promise<void> {
    if (this.treasuryPubkey) return;
    const info = await this.connection.getAccountInfo(this.configPda, "confirmed");
    if (!info) {
      throw new BatchSubmitError("ProtocolConfig not found on-chain");
    }
    const cfg = decodeProtocolConfig(info.data);
    this.treasuryPubkey = new PublicKey(cfg.treasury);
    this.protocolFeeBps = cfg.protocolFeeBps;
  }
}

// ---------------------------------------------------------------------------
// Plan + helpers
// ---------------------------------------------------------------------------

interface CallPlan {
  idx: number;
  callId: string;
  agentPubkey: string;
  policyPda: PublicKey;
  agentAta: PublicKey;
  referrerTokenAccount?: PublicKey;
  callValue: bigint;
  split: PremiumSplit;
}

export interface PremiumSplit {
  gross: bigint;
  poolCut: bigint;
  treasuryCut: bigint;
  referrerCut: bigint;
}

/**
 * Mirror of V2's on-chain `settle_premium.rs` split math (Phase 5 F1):
 *
 *   gross = max(callValue * insuranceRateBps / 10_000,
 *               callValue * minPremiumBps / 10_000)
 *   treasuryCut = gross * protocolFeeBps / 10_000
 *   referrerCut = gross * referrerShareBps / 10_000   (0 when no referrer)
 *   poolCut     = gross - treasuryCut - referrerCut   (residual)
 *
 * Exported for unit tests.
 */
export function splitPremium(
  callValue: bigint,
  insuranceRateBps: number,
  minPremiumBps: number,
  protocolFeeBps: number,
  referrerShareBps: number
): PremiumSplit {
  const TEN_THOUSAND = 10_000n;
  const rate = BigInt(Math.max(insuranceRateBps, 0));
  const floor = BigInt(Math.max(minPremiumBps, 0));
  const fee = BigInt(Math.max(protocolFeeBps, 0));
  const ref = BigInt(Math.max(referrerShareBps, 0));
  const grossRate = (callValue * rate) / TEN_THOUSAND;
  const grossFloor = (callValue * floor) / TEN_THOUSAND;
  const gross = grossRate > grossFloor ? grossRate : grossFloor;
  const treasuryCut = (gross * fee) / TEN_THOUSAND;
  const referrerCut = (gross * ref) / TEN_THOUSAND;
  const poolCut = gross - treasuryCut - referrerCut;
  return { gross, poolCut, treasuryCut, referrerCut };
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}
