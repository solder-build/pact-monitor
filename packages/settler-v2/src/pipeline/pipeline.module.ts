import { Module } from "@nestjs/common";
import { PremiumPipelineService } from "./pipeline.service";
import { AppConfigModule } from "../config/config.module";
import { ConsumerModule } from "../consumer/consumer.module";
import { BatcherModule } from "../batcher/batcher.module";
import { PremiumSubmitterModule } from "../premium-submitter/premium-submitter.module";
import { IndexerPusherModule } from "../indexer-pusher/indexer-pusher.module";

@Module({
  imports: [
    AppConfigModule,
    ConsumerModule,
    BatcherModule,
    PremiumSubmitterModule,
    IndexerPusherModule,
  ],
  providers: [PremiumPipelineService],
  exports: [PremiumPipelineService],
})
export class PremiumPipelineModule {}
