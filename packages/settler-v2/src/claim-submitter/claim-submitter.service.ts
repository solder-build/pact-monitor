// ClaimSubmitterService — single-ix submit_claim tx per breach event.
//
// Why single-ix (not batched):
//   * Each call creates a unique Claim PDA via init-if-needed at
//     `[b"claim", policy_pda, sha256(call_id)]`. Two claims share neither
//     accounts nor seeds, so batching would just multiply ix count without
//     reducing tx size.
//   * On-chain `submit_claim` has 9 accounts (config, pool, vault, policy,
//     claim, agentAta, oracle, token_program, system_program). Two ix in
//     one tx would already pressure the 1232-byte cap once each Claim PDA
//     enters the account table.
//   * Claims are rare (breach-only) so batch efficiency matters far less.
//
// Idempotency:
//   * Before sending, derive Claim PDA and `getAccountInfo` — if present,
//     ack-skip the message (Claim PDA itself is the on-chain dedupe ledger).
//   * On send: 30s confirmation poll; on confirmation, push event to indexer.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  PROGRAM_ID,
  TriggerType,
  USDC_MINT_DEVNET,
  buildSubmitClaimIx,
  decodeCoveragePool,
  decodePolicy,
  decodeProtocolConfig,
  deriveAssociatedTokenAccount,
  getClaimPda,
  getCoveragePoolPda,
  getProtocolConfigPda,
  getVaultPda,
  hashCallId,
} from "@q3labs/pact-protocol-v2-client";
import type { SettleMessage } from "../consumer/consumer.service";
import { SecretLoaderService } from "../config/secret-loader.service";

export interface ClaimSubmitOutcome {
  signature: string;
  callId: string;
  callIdHash: string;
  claimPda: string;
  policyPda: string;
  pool: string;
  agentPubkey: string;
  paymentAmount: bigint;
  refundAmount: bigint;
  evidenceHash: string;
  statusCode: number;
  latencyMs: number;
  triggerType: TriggerType;
  callTimestamp: bigint;
  /** True iff a Claim PDA already existed; tx not sent, message ack-skipped. */
  shortCircuited: boolean;
}

export class ClaimSubmitError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ClaimSubmitError";
  }
}

@Injectable()
export class ClaimSubmitterService {
  private readonly logger = new Logger(ClaimSubmitterService.name);
  private readonly programId: PublicKey;
  private readonly usdcMint: PublicKey;
  private readonly configPda: PublicKey;
  private readonly cuLimit: number;
  private readonly cuPriceMicroLamports: number;
  private readonly confirmTimeoutMs: number;
  private readonly confirmPollMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly connection: Connection,
    private readonly secrets: SecretLoaderService
  ) {
    this.programId = new PublicKey(this.config.getOrThrow<string>("PROGRAM_ID"));
    const usdc = this.config.get<string>("USDC_MINT");
    this.usdcMint = usdc ? new PublicKey(usdc) : USDC_MINT_DEVNET;
    [this.configPda] = getProtocolConfigPda(this.programId);
    this.cuLimit = Number(this.config.get("COMPUTE_UNIT_LIMIT")) || 1_400_000;
    this.cuPriceMicroLamports =
      Number(this.config.get("COMPUTE_UNIT_PRICE_MICROLAMPORTS")) || 5000;
    this.confirmTimeoutMs =
      Number(this.config.get("CONFIRM_TIMEOUT_MS")) || 30_000;
    this.confirmPollMs =
      Number(this.config.get("CONFIRM_POLL_INTERVAL_MS")) || 500;
    void PROGRAM_ID;
  }

  async submit(message: SettleMessage): Promise<ClaimSubmitOutcome> {
    const d = message.data as Record<string, unknown>;
    const callId = String(d["callId"] ?? "");
    const agentPubkey = String(d["agentPubkey"] ?? "");
    const hostname = String(d["hostname"] ?? "");
    const policyPdaStr = String(d["policyPda"] ?? "");
    const paymentAmount = BigInt(String(d["paymentAmount"] ?? "0"));
    const triggerTypeRaw = Number(d["triggerType"] ?? -1);
    const evidenceHashHex = String(d["evidenceHash"] ?? "");
    const statusCode = Number(d["statusCode"] ?? 0);
    const latencyMs = Number(d["latencyMs"] ?? 0);
    const callTimestamp = BigInt(String(d["callTimestamp"] ?? "0"));

    if (
      !callId ||
      !agentPubkey ||
      !hostname ||
      !policyPdaStr ||
      paymentAmount === 0n ||
      triggerTypeRaw < 0 ||
      triggerTypeRaw > 3 ||
      evidenceHashHex.length !== 64
    ) {
      throw new ClaimSubmitError(
        `claim event malformed: callId=${callId} payment=${paymentAmount} trigger=${triggerTypeRaw} evidenceLen=${evidenceHashHex.length}`
      );
    }

    const policyPk = new PublicKey(policyPdaStr);
    const [poolPda] = getCoveragePoolPda(this.programId, hostname);
    const [vault] = getVaultPda(this.programId, poolPda);
    const [claimPda] = getClaimPda(this.programId, policyPk, callId);
    const callIdHash = bytesToHex(hashCallId(callId));

    // Idempotency: skip if Claim PDA already exists.
    const claimInfo = await this.connection.getAccountInfo(claimPda, "confirmed");
    if (claimInfo) {
      this.logger.debug(
        `Claim PDA ${claimPda.toBase58()} already exists; ack-skipping callId=${callId}`
      );
      return {
        signature: "",
        callId,
        callIdHash,
        claimPda: claimPda.toBase58(),
        policyPda: policyPdaStr,
        pool: poolPda.toBase58(),
        agentPubkey,
        paymentAmount,
        refundAmount: paymentAmount, // best-effort; the real on-chain refund
        // may have been clamped — indexer reads truth from the Claim
        // account via the watcher path.
        evidenceHash: evidenceHashHex,
        statusCode,
        latencyMs,
        triggerType: triggerTypeRaw as TriggerType,
        callTimestamp,
        shortCircuited: true,
      };
    }

    // Validate policy + pool exist (cheap pre-flight; saves a tx rejection
    // round-trip if the dashboard hasn't refreshed yet).
    const policyInfo = await this.connection.getAccountInfo(policyPk, "confirmed");
    if (!policyInfo) {
      throw new ClaimSubmitError(
        `policy ${policyPdaStr} not found on-chain for callId=${callId}`
      );
    }
    const policy = decodePolicy(policyInfo.data);
    const agentAta = deriveAssociatedTokenAccount(
      new PublicKey(policy.agent),
      this.usdcMint
    );

    const poolInfo = await this.connection.getAccountInfo(poolPda, "confirmed");
    if (!poolInfo) {
      throw new ClaimSubmitError(
        `pool not found on-chain for hostname=${hostname}`
      );
    }
    void decodeCoveragePool(poolInfo.data);

    await this.ensureProtocolConfigExists();

    const oracle = this.secrets.keypair;
    const evidenceHash = hexToBytes(evidenceHashHex);

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.cuPriceMicroLamports,
      })
    );
    tx.add(
      buildSubmitClaimIx({
        programId: this.programId,
        configPda: this.configPda,
        poolPda,
        vault,
        policyPda: policyPk,
        claimPda,
        agentAta,
        oracle: oracle.publicKey,
        callId,
        triggerType: triggerTypeRaw as TriggerType,
        evidenceHash,
        callTimestamp,
        latencyMs,
        statusCode,
        paymentAmount,
      })
    );

    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = oracle.publicKey;
    tx.sign(oracle);

    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
    } catch (err) {
      throw new ClaimSubmitError(
        `sendRawTransaction failed: ${(err as Error).message}`,
        err
      );
    }

    const confirmed = await this.pollConfirmation(signature);
    if (!confirmed) {
      throw new ClaimSubmitError(`confirmation timeout for tx ${signature}`);
    }

    return {
      signature,
      callId,
      callIdHash,
      claimPda: claimPda.toBase58(),
      policyPda: policyPdaStr,
      pool: poolPda.toBase58(),
      agentPubkey,
      paymentAmount,
      // Refund amount is the on-chain clamp; the cranker doesn't know it yet,
      // but indexer's watcher path will read it from the Claim account.
      // Surface paymentAmount as a best-effort here.
      refundAmount: paymentAmount,
      evidenceHash: evidenceHashHex,
      statusCode,
      latencyMs,
      triggerType: triggerTypeRaw as TriggerType,
      callTimestamp,
      shortCircuited: false,
    };
  }

  private async pollConfirmation(signature: string): Promise<boolean> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    while (Date.now() < deadline) {
      const statuses = await this.connection.getSignatureStatuses(
        [signature],
        { searchTransactionHistory: false }
      );
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

  private async ensureProtocolConfigExists(): Promise<void> {
    const info = await this.connection.getAccountInfo(this.configPda, "confirmed");
    if (!info) {
      throw new ClaimSubmitError(
        "ProtocolConfig not found on-chain — cranker cannot submit claims"
      );
    }
    void decodeProtocolConfig(info.data);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`invalid hex length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
