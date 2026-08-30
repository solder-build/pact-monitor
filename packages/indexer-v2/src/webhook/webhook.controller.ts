import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { PushSecretGuard } from "../guards/push-secret.guard";
import { WebhookService } from "./webhook.service";
import type {
  HeliusAccountChange,
  HeliusAccountChangeBatch,
} from "./webhook.dto";

@Controller("webhook")
@UseGuards(PushSecretGuard)
export class WebhookController {
  constructor(private readonly service: WebhookService) {}

  @Post("helius/accounts")
  @HttpCode(200)
  async heliusAccounts(
    @Body() body: HeliusAccountChangeBatch | HeliusAccountChange[]
  ): Promise<{ ok: true; processed: number; skipped: number }> {
    // Helius can post either {changes: [...]} or [...] depending on
    // webhook config. Accept both.
    const changes = Array.isArray(body) ? body : body.changes;
    const result = await this.service.ingestBatch(changes ?? []);
    return { ok: true, ...result };
  }
}
