// Second ConsumerService instance — same contract as ConsumerService but
// binds to the claim subscription (PUBSUB_SUBSCRIPTION_CLAIM /
// REDIS_STREAM_CLAIM). Used by C4's ClaimPipelineService.

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import type { QueueConsumer, SettleMessage } from "./queue-consumer.interface";

export const CLAIM_QUEUE_CONSUMER = Symbol("CLAIM_QUEUE_CONSUMER");

@Injectable()
export class ClaimConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClaimConsumerService.name);
  constructor(
    @Inject(CLAIM_QUEUE_CONSUMER) private readonly consumer: QueueConsumer
  ) {}
  async onModuleInit(): Promise<void> {
    await this.consumer.init();
  }
  async onModuleDestroy(): Promise<void> {
    await this.consumer.destroy();
  }
  setEnqueueCallback(cb: (msg: SettleMessage) => void): void {
    this.consumer.setEnqueueCallback(cb);
  }
  drain(): SettleMessage[] {
    return this.consumer.drain();
  }
  ack(messages: SettleMessage[]): void {
    this.consumer.ack(messages);
  }
  nack(messages: SettleMessage[]): void {
    this.consumer.nack(messages);
  }
  get queueLength(): number {
    return this.consumer.queueLength;
  }
}
