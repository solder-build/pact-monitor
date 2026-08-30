import { Module } from "@nestjs/common";
import { ClaimPipelineService } from "./claim-pipeline.service";
import { AppConfigModule } from "../config/config.module";
import { ConsumerModule } from "../consumer/consumer.module";
import { ClaimConsumerModule } from "../consumer/claim-consumer.module";
import { ClaimSubmitterModule } from "../claim-submitter/claim-submitter.module";
import { IndexerPusherModule } from "../indexer-pusher/indexer-pusher.module";

@Module({
  // ConsumerModule first so REDIS_CLIENT is provided once and reused by
  // both pipelines.
  imports: [
    AppConfigModule,
    ConsumerModule,
    ClaimConsumerModule,
    ClaimSubmitterModule,
    IndexerPusherModule,
  ],
  providers: [ClaimPipelineService],
  exports: [ClaimPipelineService],
})
export class ClaimPipelineModule {}
