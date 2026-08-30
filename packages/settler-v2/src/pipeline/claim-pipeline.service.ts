// ClaimPipelineService — drives one submit_claim tx per breach event.
//
// Differs from PremiumPipelineService:
//   * One message per tx (no batcher). Each Claim PDA is unique so batching
//     adds account-table pressure for no efficiency win.
//   * Idempotency lives on-chain (Claim PDA exists → ack-skip, handled in
//     ClaimSubmitterService).
//   * Indexer push body is the V2Claim ledger row shape (Locked decision:
//     counter mutations on V2Pool/V2Policy stay watcher-owned).

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ClaimConsumerService } from "../consumer/claim-consumer.service";
import {
  ClaimSubmitError,
  ClaimSubmitterService,
} from "../claim-submitter/claim-submitter.service";
import {
  IndexerPushError,
  IndexerPusherService,
} from "../indexer-pusher/indexer-pusher.service";

@Injectable()
export class ClaimPipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClaimPipelineService.name);
  private inflight = new Set<Promise<void>>();
  private shuttingDown = false;
  private lastSuccessAt: number | null = null;

  constructor(
    private readonly consumer: ClaimConsumerService,
    private readonly submitter: ClaimSubmitterService,
    private readonly indexerPusher: IndexerPusherService
  ) {}

  onModuleInit(): void {
    this.consumer.setEnqueueCallback((msg) => {
      if (this.shuttingDown) {
        this.logger.warn(`Dropping claim message during shutdown: ${msg.id}`);
        return;
      }
      const p = this.processMessage(msg);
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.logger.log("ClaimPipeline draining in-flight");
    if (this.inflight.size > 0) {
      await Promise.allSettled(Array.from(this.inflight));
    }
    this.logger.log("ClaimPipeline drained.");
  }

  private async processMessage(
    msg: import("../consumer/consumer.service").SettleMessage
  ): Promise<void> {
    let outcome;
    try {
      outcome = await this.submitter.submit(msg);
    } catch (err) {
      if (err instanceof ClaimSubmitError) {
        this.logger.error(
          `Claim submit failed; nacking msgId=${msg.id}: ${err.message}`
        );
        msg.nack();
        return;
      }
      throw err;
    }

    // Short-circuit (Claim PDA already exists): ack without indexer push.
    // The watcher path will have already (or will soon) ingest the Claim
    // account via its own subscription channel.
    if (outcome.shortCircuited) {
      msg.ack();
      return;
    }

    try {
      await this.indexerPusher.pushClaim({
        signature: outcome.signature,
        ts: new Date().toISOString(),
        claim: {
          callId: outcome.callId,
          callIdHash: outcome.callIdHash,
          claimPda: outcome.claimPda,
          policyPda: outcome.policyPda,
          pool: outcome.pool,
          agentPubkey: outcome.agentPubkey,
          paymentAmount: outcome.paymentAmount.toString(),
          refundAmount: outcome.refundAmount.toString(),
          evidenceHash: outcome.evidenceHash,
          statusCode: outcome.statusCode,
          latencyMs: outcome.latencyMs,
          triggerType: outcome.triggerType,
          callTimestamp: outcome.callTimestamp.toString(),
        },
      });
    } catch (err) {
      if (err instanceof IndexerPushError) {
        // Tx is on-chain. On nack-redeliver, the Claim PDA short-circuit
        // path acks the message; the watcher path picks up the on-chain
        // truth independently — so ledger eventually consistent without
        // a double-submit.
        this.logger.error(
          `Indexer push failed for claim tx ${outcome.signature}; nacking: ${err.message}`
        );
        msg.nack();
        return;
      }
      throw err;
    }

    this.lastSuccessAt = Date.now();
    msg.ack();
  }

  get lagMs(): number | null {
    if (this.lastSuccessAt === null) return null;
    return Date.now() - this.lastSuccessAt;
  }
}
