import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppConfigModule } from "./config/config.module";
import { PrismaModule } from "./prisma/prisma.module";
import { PremiumPipelineModule } from "./pipeline/pipeline.module";
import { ClaimPipelineModule } from "./pipeline/claim-pipeline.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AppConfigModule,
    PrismaModule,
    PremiumPipelineModule,
    ClaimPipelineModule,
  ],
})
export class AppModule {}
