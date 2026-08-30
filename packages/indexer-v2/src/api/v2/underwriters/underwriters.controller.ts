import { Controller, Get, Param } from "@nestjs/common";
import { UnderwritersService } from "./underwriters.service";

@Controller("api/v2/underwriters")
export class UnderwritersController {
  constructor(private readonly service: UnderwritersService) {}

  @Get(":pubkey/positions")
  listPositions(@Param("pubkey") pubkey: string) {
    return this.service.listPositions(pubkey);
  }
}
