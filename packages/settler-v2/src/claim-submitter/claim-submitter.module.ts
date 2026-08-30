import { Module } from "@nestjs/common";
import { ClaimSubmitterService } from "./claim-submitter.service";
import { AppConfigModule } from "../config/config.module";
import { PremiumSubmitterModule } from "../premium-submitter/premium-submitter.module";

@Module({
  // Reuse the shared Connection provider from PremiumSubmitterModule.
  imports: [AppConfigModule, PremiumSubmitterModule],
  providers: [ClaimSubmitterService],
  exports: [ClaimSubmitterService],
})
export class ClaimSubmitterModule {}
