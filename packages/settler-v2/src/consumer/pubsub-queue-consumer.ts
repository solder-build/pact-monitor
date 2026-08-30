import { Logger } from "@nestjs/common";
import type { Message, PubSub, Subscription } from "@google-cloud/pubsub";
import type { QueueConsumer, SettleMessage } from "./queue-consumer.interface";

export interface PubSubQueueConsumerConfig {
  projectId: string;
  subscriptionName: string;
}

export class PubSubQueueConsumer implements QueueConsumer {
  private readonly logger = new Logger(PubSubQueueConsumer.name);
  private subscription: Subscription | null = null;
  private readonly queue: SettleMessage[] = [];
  private onEnqueue: ((msg: SettleMessage) => void) | null = null;

  constructor(
    private readonly pubsub: PubSub,
    private readonly config: PubSubQueueConsumerConfig
  ) {}

  init(): void {
    const fullName = `projects/${this.config.projectId}/subscriptions/${this.config.subscriptionName}`;
    this.subscription = this.pubsub.subscription(fullName);

    this.subscription.on("message", (msg: Message) => {
      const settle: SettleMessage = {
        id: msg.id,
        data: JSON.parse(msg.data.toString("utf8")),
        ack: () => msg.ack(),
        nack: () => msg.nack(),
      };
      this.queue.push(settle);
      this.onEnqueue?.(settle);
    });
    this.subscription.on("error", (err) => {
      this.logger.error("Pub/Sub subscription error", err);
    });
  }

  destroy(): void {
    this.subscription?.removeAllListeners();
    this.subscription?.close();
  }

  setEnqueueCallback(cb: (msg: SettleMessage) => void): void {
    this.onEnqueue = cb;
  }

  drain(): SettleMessage[] {
    return this.queue.splice(0, this.queue.length);
  }

  ack(messages: SettleMessage[]): void {
    for (const m of messages) m.ack();
  }
  nack(messages: SettleMessage[]): void {
    for (const m of messages) m.nack();
  }
  get queueLength(): number {
    return this.queue.length;
  }
}
