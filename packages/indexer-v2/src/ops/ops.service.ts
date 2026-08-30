// OpsService — builds real unsigned Solana transactions for V2 admin ops.
//
// NOT V1's JSON-envelope shim (B6 bug). Each handler:
//   1. Resolves any PDAs required by the V2 ix.
//   2. Calls the appropriate v2-client buildXIx().
//   3. Wraps the ix in a Transaction with feePayer set to the operator's
//      signer pubkey + a recent blockhash.
//   4. Returns
//      { unsignedTx, recentBlockhash, lastValidBlockHeight, message }
//      so the operator's wallet can sign + send. `message` is the same
//      Tx serialized with `serializeMessage()` for wallets that prefer
//      the message form over the raw tx.

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  USDC_MINT_DEVNET,
  buildCreatePoolIx,
  buildUpdateConfigIx,
  buildUpdateOracleIx,
  buildUpdateRatesIx,
  getCoveragePoolPda,
  getProtocolConfigPda,
  getVaultPda,
} from "@q3labs/pact-protocol-v2-client";

export interface UnsignedTxResponse {
  unsignedTx: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
}

export interface PauseParams {
  signerPubkey: string;
  paused: boolean;
}

export interface UpdateConfigOpsParams {
  signerPubkey: string;
  protocolFeeBps?: number;
  minPoolDeposit?: string;
  defaultInsuranceRateBps?: number;
  defaultMaxCoveragePerCall?: string;
  minPremiumBps?: number;
  withdrawalCooldownSeconds?: string;
  aggregateCapBps?: number;
  aggregateCapWindowSeconds?: string;
  claimWindowSeconds?: string;
  maxClaimsPerBatch?: number;
  paused?: boolean;
}

export interface UpdateOracleOpsParams {
  signerPubkey: string;
  newOracle: string;
}

export interface CreatePoolOpsParams {
  signerPubkey: string;
  hostname: string;
  poolUsdcMint?: string;
  insuranceRateBps?: number;
  maxCoveragePerCall?: string;
}

export interface UpdateRatesOpsParams {
  signerPubkey: string;
  hostname: string;
  newRateBps: number;
}

@Injectable()
export class OpsService {
  private readonly programId: PublicKey;
  private readonly configPda: PublicKey;
  private readonly defaultMint: PublicKey;
  private readonly connection: Connection;

  constructor(config: ConfigService) {
    this.programId = new PublicKey(config.getOrThrow<string>("PROGRAM_ID"));
    [this.configPda] = getProtocolConfigPda(this.programId);
    const usdc = config.get<string>("USDC_MINT");
    this.defaultMint = usdc ? new PublicKey(usdc) : USDC_MINT_DEVNET;
    // RPC URL falls back to devnet for ops blockhash fetches. Tests
    // override via DI.
    const rpcUrl = config.get<string>("SOLANA_RPC_URL") ??
      "https://api.devnet.solana.com";
    this.connection = new Connection(rpcUrl, "confirmed");
    void PROGRAM_ID;
  }

  // Test seam — DI Connection override.
  setConnection(c: Connection): void {
    (this as any).connection = c;
  }

  async pause(p: PauseParams): Promise<UnsignedTxResponse> {
    return this.buildUpdateConfig({
      signerPubkey: p.signerPubkey,
      paused: p.paused,
    });
  }

  async unpause(p: PauseParams): Promise<UnsignedTxResponse> {
    return this.buildUpdateConfig({
      signerPubkey: p.signerPubkey,
      paused: false,
    });
  }

  async updateConfig(p: UpdateConfigOpsParams): Promise<UnsignedTxResponse> {
    return this.buildUpdateConfig(p);
  }

  async updateOracle(p: UpdateOracleOpsParams): Promise<UnsignedTxResponse> {
    const ix = buildUpdateOracleIx({
      programId: this.programId,
      configPda: this.configPda,
      authority: new PublicKey(p.signerPubkey),
      newOracle: new PublicKey(p.newOracle),
    });
    return this.wrap(ix, new PublicKey(p.signerPubkey));
  }

  async createPool(p: CreatePoolOpsParams): Promise<UnsignedTxResponse> {
    const [poolPda] = getCoveragePoolPda(this.programId, p.hostname);
    const [vault] = getVaultPda(this.programId, poolPda);
    const poolUsdcMint = p.poolUsdcMint
      ? new PublicKey(p.poolUsdcMint)
      : this.defaultMint;
    const ix = buildCreatePoolIx({
      programId: this.programId,
      configPda: this.configPda,
      poolPda,
      vaultPda: vault,
      poolUsdcMint,
      authority: new PublicKey(p.signerPubkey),
      hostname: p.hostname,
      insuranceRateBps: p.insuranceRateBps,
      maxCoveragePerCall: p.maxCoveragePerCall
        ? BigInt(p.maxCoveragePerCall)
        : undefined,
    });
    return this.wrap(ix, new PublicKey(p.signerPubkey));
  }

  async updateRates(p: UpdateRatesOpsParams): Promise<UnsignedTxResponse> {
    const [poolPda] = getCoveragePoolPda(this.programId, p.hostname);
    const ix = buildUpdateRatesIx({
      programId: this.programId,
      configPda: this.configPda,
      poolPda,
      oracleSigner: new PublicKey(p.signerPubkey),
      newRateBps: p.newRateBps,
    });
    return this.wrap(ix, new PublicKey(p.signerPubkey));
  }

  private async buildUpdateConfig(
    p: UpdateConfigOpsParams
  ): Promise<UnsignedTxResponse> {
    const ix = buildUpdateConfigIx({
      programId: this.programId,
      configPda: this.configPda,
      authority: new PublicKey(p.signerPubkey),
      protocolFeeBps: p.protocolFeeBps,
      minPoolDeposit: p.minPoolDeposit ? BigInt(p.minPoolDeposit) : undefined,
      defaultInsuranceRateBps: p.defaultInsuranceRateBps,
      defaultMaxCoveragePerCall: p.defaultMaxCoveragePerCall
        ? BigInt(p.defaultMaxCoveragePerCall)
        : undefined,
      minPremiumBps: p.minPremiumBps,
      withdrawalCooldownSeconds: p.withdrawalCooldownSeconds
        ? BigInt(p.withdrawalCooldownSeconds)
        : undefined,
      aggregateCapBps: p.aggregateCapBps,
      aggregateCapWindowSeconds: p.aggregateCapWindowSeconds
        ? BigInt(p.aggregateCapWindowSeconds)
        : undefined,
      claimWindowSeconds: p.claimWindowSeconds
        ? BigInt(p.claimWindowSeconds)
        : undefined,
      maxClaimsPerBatch: p.maxClaimsPerBatch,
      paused: p.paused,
    });
    return this.wrap(ix, new PublicKey(p.signerPubkey));
  }

  private async wrap(
    ix: import("@solana/web3.js").TransactionInstruction,
    feePayer: PublicKey
  ): Promise<UnsignedTxResponse> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction();
    tx.add(ix);
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = feePayer;
    const serialized = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
    return {
      unsignedTx: serialized,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
    };
  }
}
