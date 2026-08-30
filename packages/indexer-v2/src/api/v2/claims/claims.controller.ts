import { Controller, Get, Param } from "@nestjs/common";
import { ClaimsService } from "./claims.service";

@Controller("api/v2/claims")
export class ClaimsController {
  constructor(private readonly service: ClaimsService) {}

  @Get(":callIdHash")
  byCallIdHash(@Param("callIdHash") callIdHash: string) {
    return this.service.getByCallIdHash(callIdHash);
  }
}
