import { Module } from "@nestjs/common";
import { IndexerPusherService } from "./indexer-pusher.service";

@Module({
  providers: [IndexerPusherService],
  exports: [IndexerPusherService],
})
export class IndexerPusherModule {}
