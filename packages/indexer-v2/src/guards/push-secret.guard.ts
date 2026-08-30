// PushSecretGuard — bearer-token gate for the /events and /webhook routes
// invoked by settler-v2 and Helius. Pattern lifted from V1
// indexer/guards/push-secret.guard.ts; constant-time comparison plus
// optional secret (Helius webhook key is allowed to be unset in dev).

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "crypto";

@Injectable()
export class PushSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const expectedKey = this.expectedEnvVar(context);
    const expected = this.config.get<string>(expectedKey);
    if (!expected) {
      throw new UnauthorizedException(
        `indexer-v2: ${expectedKey} is not configured`
      );
    }
    const auth = req.headers?.authorization as string | undefined;
    if (!auth || !auth.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing bearer token");
    }
    const provided = auth.slice("Bearer ".length).trim();
    if (!safeEqual(provided, expected)) {
      throw new UnauthorizedException("invalid bearer token");
    }
    return true;
  }

  /**
   * Determine which env var to check based on the route. Webhook routes
   * use HELIUS_WEBHOOK_SECRET; everything else uses
   * INDEXER_V2_PUSH_SECRET.
   */
  private expectedEnvVar(context: ExecutionContext): string {
    const req = context.switchToHttp().getRequest();
    const path = (req.url ?? "") as string;
    if (path.startsWith("/webhook/")) return "HELIUS_WEBHOOK_SECRET";
    return "INDEXER_V2_PUSH_SECRET";
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
