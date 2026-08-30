// V2 ConsumerModule. Two subscriptions exist (premium + claim); the C3 wire
// pulls only the PREMIUM subscription. C4 adds a second ConsumerService for
// the claim pipeline.

import { Module, type FactoryProvider, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PubSub } from "@google-cloud/pubsub";
import { ConsumerService, QUEUE_CONSUMER } from "./consumer.service";
import { PubSubQueueConsumer } from "./pubsub-queue-consumer";
import { RedisStreamsQueueConsumer } from "./redis-streams-queue-consumer";
import type { QueueConsumer } from "./queue-consumer.interface";

export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

const pubsubProvider: FactoryProvider<PubSub> = {
  provide: PubSub,
  useFactory: (): PubSub => new PubSub(),
};

const redisClientProvider: FactoryProvider<unknown> = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): unknown => {
    const backend = config.get<string>("QUEUE_BACKEND") ?? "pubsub";
    if (backend !== "redis-streams") return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis").default ?? require("ioredis");
    return new IORedis(config.getOrThrow<string>("REDIS_URL"));
  },
};

const queueConsumerProvider: FactoryProvider<QueueConsumer> = {
  provide: QUEUE_CONSUMER,
  inject: [ConfigService, PubSub, REDIS_CLIENT],
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
          "PUBSUB_SUBSCRIPTION_PREMIUM"
        ),
      });
    }
    if (backend === "redis-streams") {
      if (!redis) {
        throw new Error(
          "settler-v2: REDIS_CLIENT returned null despite QUEUE_BACKEND=redis-streams"
        );
      }
      return new RedisStreamsQueueConsumer(
        redis as import("ioredis").Redis,
        {
          stream: config.getOrThrow<string>("REDIS_STREAM_PREMIUM"),
          group: config.get<string>("REDIS_CONSUMER_GROUP") ?? "settler-v2",
        }
      );
    }
    throw new Error(`settler-v2: unknown QUEUE_BACKEND="${backend}"`);
  },
};

const providers: Provider[] = [
  pubsubProvider,
  redisClientProvider,
  queueConsumerProvider,
  ConsumerService,
];

@Module({
  providers,
  exports: [ConsumerService],
})
export class ConsumerModule {}
