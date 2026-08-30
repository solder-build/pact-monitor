import { Module, type FactoryProvider, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PubSub } from "@google-cloud/pubsub";
import {
  CLAIM_QUEUE_CONSUMER,
  ClaimConsumerService,
} from "./claim-consumer.service";
import { PubSubQueueConsumer } from "./pubsub-queue-consumer";
import { RedisStreamsQueueConsumer } from "./redis-streams-queue-consumer";
import { REDIS_CLIENT } from "./consumer.module";
import type { QueueConsumer } from "./queue-consumer.interface";

const claimPubsubProvider: FactoryProvider<PubSub> = {
  provide: "CLAIM_PUBSUB",
  useFactory: (): PubSub => new PubSub(),
};

const claimQueueConsumerProvider: FactoryProvider<QueueConsumer> = {
  provide: CLAIM_QUEUE_CONSUMER,
  inject: [ConfigService, "CLAIM_PUBSUB", REDIS_CLIENT],
  useFactory: (
    config: ConfigService,
    pubsub: PubSub,
    redis: unknown
  ): QueueConsumer => {
    const backend = config.get<string>("QUEUE_BACKEND") ?? "pubsub";
    if (backend === "pubsub") {
      return new PubSubQueueConsumer(pubsub, {
        projectId: config.getOrThrow<string>("PUBSUB_PROJECT"),
        subscriptionName: config.getOrThrow<string>(
          "PUBSUB_SUBSCRIPTION_CLAIM"
        ),
      });
    }
    if (backend === "redis-streams") {
      if (!redis) {
        throw new Error(
          "settler-v2 (claim): REDIS_CLIENT null despite QUEUE_BACKEND=redis-streams"
        );
      }
      return new RedisStreamsQueueConsumer(
        redis as import("ioredis").Redis,
        {
          stream: config.getOrThrow<string>("REDIS_STREAM_CLAIM"),
          group:
            (config.get<string>("REDIS_CONSUMER_GROUP") ?? "settler-v2") +
            "-claim",
        }
      );
    }
    throw new Error(`settler-v2 (claim): unknown QUEUE_BACKEND="${backend}"`);
  },
};

const providers: Provider[] = [
  claimPubsubProvider,
  claimQueueConsumerProvider,
  ClaimConsumerService,
];

@Module({
  providers,
  exports: [ClaimConsumerService],
})
export class ClaimConsumerModule {}
