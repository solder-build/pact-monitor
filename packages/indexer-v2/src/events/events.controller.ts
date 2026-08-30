import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { PushSecretGuard } from "../guards/push-secret.guard";
import { EventsService } from "./events.service";
import type {
  SettlePremiumEventDto,
  SubmitClaimEventDto,
} from "./events.dto";

@Controller("events")
@UseGuards(PushSecretGuard)
export class EventsController {
  constructor(private readonly service: EventsService) {}

  @Post("settle-premium")
  @HttpCode(200)
  async settlePremium(
    @Body() body: SettlePremiumEventDto
  ): Promise<{ ok: true; inserted: number }> {
    const { inserted } = await this.service.ingestSettlePremium(body);
    return { ok: true, inserted };
  }

  @Post("submit-claim")
  @HttpCode(200)
  async submitClaim(
    @Body() body: SubmitClaimEventDto
  ): Promise<{ ok: true; inserted: boolean }> {
    const { inserted } = await this.service.ingestSubmitClaim(body);
    return { ok: true, inserted };
  }
}
