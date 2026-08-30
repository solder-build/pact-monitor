import { Module } from "@nestjs/common";
import { UnderwritersController } from "./underwriters.controller";
import { UnderwritersService } from "./underwriters.service";

@Module({
  controllers: [UnderwritersController],
  providers: [UnderwritersService],
})
export class UnderwritersModule {}
