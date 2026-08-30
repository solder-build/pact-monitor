import { Module } from "@nestjs/common";
import { SecretLoaderService } from "./secret-loader.service";

@Module({
  providers: [SecretLoaderService],
  exports: [SecretLoaderService],
})
export class AppConfigModule {}
