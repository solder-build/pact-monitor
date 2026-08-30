import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Connection } from "@solana/web3.js";
import { PremiumSubmitterService } from "./premium-submitter.service";
import { AppConfigModule } from "../config/config.module";

/**
 * Provides a long-lived RPC `Connection` to the rest of the pipeline. Cloud
 * Run keeps each instance warm long enough that connection reuse is the
 * common case; the connection is constructed once per process.
 */
const connectionProvider = {
  provide: Connection,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Connection => {
    const url = config.getOrThrow<string>("SOLANA_RPC_URL");
    return new Connection(url, "confirmed");
  },
};

@Module({
  imports: [AppConfigModule],
  providers: [connectionProvider, PremiumSubmitterService],
  exports: [PremiumSubmitterService, Connection],
})
export class PremiumSubmitterModule {}
