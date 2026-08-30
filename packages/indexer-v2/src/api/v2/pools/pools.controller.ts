import { Controller, Get, Param, Query } from "@nestjs/common";
import { PoolsService } from "./pools.service";

@Controller("api/v2/pools")
export class PoolsController {
  constructor(private readonly service: PoolsService) {}

  @Get()
  list(
    @Query("hostnameLike") hostnameLike?: string,
    @Query("sort") sort?: "tvlDesc" | "tvlAsc" | "claimsDesc",
    @Query("limit") limitStr?: string
  ) {
    return this.service.list({
      hostnameLike,
      sort,
      limit: limitStr ? Number(limitStr) : undefined,
    });
  }

  @Get(":hostname")
  byHostname(@Param("hostname") hostname: string) {
    return this.service.getByHostname(hostname);
  }
}
