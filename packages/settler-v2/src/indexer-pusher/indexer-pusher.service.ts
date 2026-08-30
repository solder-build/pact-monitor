// IndexerPusherService — POSTs settlement events to indexer-v2.
//
// V2 endpoints (locked decision: ledger-only writes, no counter mutations
// on V2Pool/V2Policy — watcher path owns those):
//
//   POST /events/settle-premium
//   POST /events/submit-claim    (used in C4)
//
// Body shape for /events/settle-premium:
//   {
//     signature: string,
//     ts: string,                          // ISO-8601
//     calls: Array<{
//       callId: string,
//       callIdHash: string,                // sha256 hex
//       agentPubkey: string,
//       policyPda: string,
//       callValue: string,                 // bigint as decimal
//       poolCut: string,
//       treasuryCut: string,
//       referrerCut: string
//     }>
//   }

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import {
  PerCallShare,
  PremiumSubmitOutcome,
} from "../premium-submitter/premium-submitter.service";

export class IndexerPushError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "IndexerPushError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

@Injectable()
export class IndexerPusherService {
  private readonly logger = new Logger(IndexerPusherService.name);
  private readonly indexerUrl: string;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.indexerUrl = config.getOrThrow<string>("INDEXER_V2_URL");
    this.secret = config.getOrThrow<string>("INDEXER_V2_PUSH_SECRET");
  }

  async pushPremium(outcome: PremiumSubmitOutcome): Promise<void> {
    if (outcome.shares.length === 0) return;
    const body = {
      signature: outcome.signature,
      ts: new Date().toISOString(),
      calls: outcome.shares.map(serializeShare),
    };
    await this.postWithRetry("/events/settle-premium", body, 3);
  }

  /** Used by C4's ClaimSubmitterService. */
  async pushClaim(body: Record<string, unknown>): Promise<void> {
    await this.postWithRetry("/events/submit-claim", body, 3);
  }

  private async postWithRetry(
    path: string,
    body: unknown,
    maxAttempts: number
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await axios.post(`${this.indexerUrl}${path}`, body, {
          headers: { Authorization: `Bearer ${this.secret}` },
          timeout: 10_000,
        });
        return;
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `indexer-v2 push ${path} attempt ${attempt}/${maxAttempts} failed: ${err}`
        );
        if (attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
        }
      }
    }
    throw new IndexerPushError(
      `indexer-v2 push ${path} failed permanently after ${maxAttempts} attempts`,
      { cause: lastErr }
    );
  }
}

function serializeShare(s: PerCallShare): Record<string, string> {
  return {
    callId: s.callId,
    callIdHash: s.callIdHash,
    agentPubkey: s.agentPubkey,
    policyPda: s.policyPda,
    callValue: s.callValue.toString(),
    poolCut: s.poolCut.toString(),
    treasuryCut: s.treasuryCut.toString(),
    referrerCut: s.referrerCut.toString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
