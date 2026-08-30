import { Module } from "@nestjs/common";
import { StatsModule } from "./stats/stats.module";
import { PoolsModule } from "./pools/pools.module";
import { AgentsModule } from "./agents/agents.module";
import { ClaimsModule } from "./claims/claims.module";
import { UnderwritersModule } from "./underwriters/underwriters.module";
import { CallsModule } from "./calls/calls.module";

@Module({
  imports: [
    StatsModule,
    PoolsModule,
    AgentsModule,
    ClaimsModule,
    UnderwritersModule,
    CallsModule,
  ],
})
export class ApiV2Module {}
