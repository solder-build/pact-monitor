import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { EventsModule } from "./events/events.module";
import { WebhookModule } from "./webhook/webhook.module";
import { ApiV2Module } from "./api/v2/api.module";
import { OpsModule } from "./ops/ops.module";
import { PushSecretGuard } from "./guards/push-secret.guard";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    EventsModule,
    WebhookModule,
    ApiV2Module,
    OpsModule,
  ],
  providers: [PushSecretGuard],
})
export class AppModule {}
