import { Controller, Get, Param } from "@nestjs/common";
import { AgentsService } from "./agents.service";

@Controller("api/v2/agents")
export class AgentsController {
  constructor(private readonly service: AgentsService) {}

  @Get(":pubkey")
  getAgent(@Param("pubkey") pubkey: string) {
    return this.service.getAgent(pubkey);
  }

  @Get(":pubkey/policies")
  listPolicies(@Param("pubkey") pubkey: string) {
    return this.service.listPolicies(pubkey);
  }

  @Get(":pubkey/policies/:hostname")
  getPolicy(
    @Param("pubkey") pubkey: string,
    @Param("hostname") hostname: string
  ) {
    return this.service.getPolicyByHostname(pubkey, hostname);
  }
}
