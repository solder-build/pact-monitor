import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

/**
 * Loads the V2 oracle keypair from ORACLE_KEY. Behavior identical to V1's
 * SecretLoaderService — accepts either a Secret Manager resource path
 * `projects/<proj>/secrets/<name>/versions/<n>` or a raw base58 secret key
 * (local dev / tests). Field name change only.
 */
@Injectable()
export class SecretLoaderService implements OnModuleInit {
  private _keypair: Keypair | null = null;
  private readonly client: SecretManagerServiceClient;

  constructor(private readonly config: ConfigService) {
    this.client = new SecretManagerServiceClient();
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    const resourcePath = this.config.getOrThrow<string>("ORACLE_KEY");
    if (!resourcePath.startsWith("projects/")) {
      const bytes = bs58.decode(resourcePath);
      this._keypair = Keypair.fromSecretKey(bytes);
      return;
    }
    const [version] = await this.client.accessSecretVersion({
      name: resourcePath,
    });
    const raw = version.payload?.data;
    if (!raw) throw new Error("settler-v2: ORACLE_KEY secret payload is empty");
    const keyStr =
      typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    const bytes = bs58.decode(keyStr.trim());
    this._keypair = Keypair.fromSecretKey(bytes);
  }

  get keypair(): Keypair {
    if (!this._keypair) {
      throw new Error("settler-v2: oracle keypair not loaded");
    }
    return this._keypair;
  }
}
