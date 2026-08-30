import { Module } from "@nestjs/common";
import { OpsController } from "./ops.controller";
import { OpsService } from "./ops.service";
import { OperatorAuthGuard } from "../guards/operator-auth.guard";

@Module({
  controllers: [OpsController],
  providers: [OpsService, OperatorAuthGuard],
})
export class OpsModule {}
