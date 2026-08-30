import { Controller, Get } from "@nestjs/common";
import { NetworkStats, StatsService } from "./stats.service";

@Controller("api/v2/stats")
export class StatsController {
  constructor(private readonly service: StatsService) {}

  @Get()
  async getStats(): Promise<NetworkStats> {
    return this.service.getStats();
  }
}
