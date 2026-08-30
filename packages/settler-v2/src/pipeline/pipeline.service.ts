// PremiumPipelineService — orchestrates the consumer → batcher → submitter →
// indexer-pusher flow for V2 settle_premium.
//
// Lifecycle:
//   * onModuleInit: wire consumer enqueue → batcher.push, batcher flush →
//     processBatch.
//   * On flush: idempotency precheck (inside submitter.submit), submit on-chain,
//     push to indexer-v2, ack the messages that participated. nack on failure.
//   * onModuleDestroy: stop accepting, force-flush batcher, drain in-flight.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConsumerService } from "../consumer/consumer.service";
import { BatcherService, SettleBatch } from "../batcher/batcher.service";
import {
  BatchSubmitError,
  PremiumSubmitterService,
} from "../premium-submitter/premium-submitter.service";
import {
  IndexerPushError,
  IndexerPusherService,
} from "../indexer-pusher/indexer-pusher.service";

@Injectable()
export class PremiumPipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PremiumPipelineService.name);
  private inflight = new Set<Promise<void>>();
  private shuttingDown = false;
  private lastSuccessAt: number | null = null;

  constructor(
    private readonly consumer: ConsumerService,
    private readonly batcher: BatcherService,
    private readonly submitter: PremiumSubmitterService,
    private readonly indexerPusher: IndexerPusherService
  ) {}

  onModuleInit(): void {
    this.consumer.setEnqueueCallback((msg) => {
      if (this.shuttingDown) {
        this.logger.warn(`Dropping message during shutdown: ${msg.id}`);
        return;
      }
      this.batcher.push(msg);
    });
    this.batcher.setFlushCallback(async (batch) => {
      const p = this.processBatch(batch);
      this.inflight.add(p);
      try {
        await p;
      } finally {
        this.inflight.delete(p);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.logger.log(
      "PremiumPipeline shutting down — flushing + draining in-flight"
    );
    try {
      await this.batcher.flushNow();
    } catch (err) {
      this.logger.error(`Final batcher flush failed: ${err}`);
    }
    if (this.inflight.size > 0) {
      this.logger.log(`Awaiting ${this.inflight.size} in-flight batches`);
      await Promise.allSettled(Array.from(this.inflight));
    }
    this.logger.log("PremiumPipeline drained.");
  }

  private async processBatch(batch: SettleBatch): Promise<void> {
    let outcome;
    try {
      outcome = await this.submitter.submit(batch);
    } catch (err) {
      if (err instanceof BatchSubmitError) {
        this.logger.error(
          `Submit failed; nacking ${batch.messages.length}: ${err.message}`
        );
        this.consumer.nack(batch.messages);
        return;
      }
      throw err;
    }

    // If everything in the batch was short-circuited (Confirmed-attempt
    // already exists), there's nothing on-chain to push to the indexer.
    if (outcome.signature === "") {
      this.lastSuccessAt = Date.now();
      // Messages were acked inside submit.submit() for short-circuit path.
      return;
    }

    try {
      await this.indexerPusher.pushPremium(outcome);
    } catch (err) {
      if (err instanceof IndexerPushError) {
        // Tx is on-chain but indexer didn't ingest. Nack so Pub/Sub redelivers;
        // on retry the V2PremiumAttempt status is Confirmed → short-circuit
        // (no double-spend), and the second pass attempts the push again.
        this.logger.error(
          `Indexer push failed for tx ${outcome.signature}; nacking accepted msgs for redelivery: ${err.message}`
        );
        const toNack = outcome.acceptedIndexes.map(
          (i) => batch.messages[i]!
        );
        this.consumer.nack(toNack);
        return;
      }
      throw err;
    }

    this.lastSuccessAt = Date.now();
    const accepted = outcome.acceptedIndexes.map((i) => batch.messages[i]!);
    this.consumer.ack(accepted);
  }

  get lagMs(): number | null {
    if (this.lastSuccessAt === null) return null;
    return Date.now() - this.lastSuccessAt;
  }
}
