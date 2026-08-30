import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { OperatorAuthGuard } from "../guards/operator-auth.guard";
import {
  CreatePoolOpsParams,
  OpsService,
  PauseParams,
  UnsignedTxResponse,
  UpdateConfigOpsParams,
  UpdateOracleOpsParams,
  UpdateRatesOpsParams,
} from "./ops.service";

interface OpRequest<P> {
  signerPubkey: string;
  signedMessage: string;
  signatureB58: string;
  nonce: string;
  params: P;
}

@Controller("api/v2/ops")
@UseGuards(OperatorAuthGuard)
export class OpsController {
  constructor(private readonly service: OpsService) {}

  @Post("pause")
  @HttpCode(200)
  pause(@Body() body: OpRequest<Omit<PauseParams, "signerPubkey">>) {
    return this.service.pause({
      signerPubkey: body.signerPubkey,
      paused: true,
    });
  }

  @Post("unpause")
  @HttpCode(200)
  unpause(@Body() body: OpRequest<Record<string, never>>) {
    return this.service.unpause({
      signerPubkey: body.signerPubkey,
      paused: false,
    });
  }

  @Post("update-config")
  @HttpCode(200)
  updateConfig(
    @Body()
    body: OpRequest<Omit<UpdateConfigOpsParams, "signerPubkey">>
  ): Promise<UnsignedTxResponse> {
    return this.service.updateConfig({
      signerPubkey: body.signerPubkey,
      ...body.params,
    });
  }

  @Post("update-oracle")
  @HttpCode(200)
  updateOracle(
    @Body()
    body: OpRequest<Omit<UpdateOracleOpsParams, "signerPubkey">>
  ): Promise<UnsignedTxResponse> {
    return this.service.updateOracle({
      signerPubkey: body.signerPubkey,
      ...body.params,
    });
  }

  @Post("create-pool")
  @HttpCode(200)
  createPool(
    @Body() body: OpRequest<Omit<CreatePoolOpsParams, "signerPubkey">>
  ): Promise<UnsignedTxResponse> {
    return this.service.createPool({
      signerPubkey: body.signerPubkey,
      ...body.params,
    });
  }

  @Post("update-rates")
  @HttpCode(200)
  updateRates(
    @Body() body: OpRequest<Omit<UpdateRatesOpsParams, "signerPubkey">>
  ): Promise<UnsignedTxResponse> {
    return this.service.updateRates({
      signerPubkey: body.signerPubkey,
      ...body.params,
    });
  }
}
