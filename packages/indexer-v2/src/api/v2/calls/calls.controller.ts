import { Controller, Get, Param } from "@nestjs/common";
import { CallsService } from "./calls.service";

@Controller("api/v2/calls")
export class CallsController {
  constructor(private readonly service: CallsService) {}

  @Get(":signature")
  bySignature(@Param("signature") signature: string) {
    return this.service.getBySignature(signature);
  }
}
