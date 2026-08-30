import { Module } from "@nestjs/common";
import { BatcherService } from "./batcher.service";

@Module({
  providers: [BatcherService],
  exports: [BatcherService],
})
export class BatcherModule {}
