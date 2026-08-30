// OperatorAuthGuard — validates an ed25519-signed message from an allowlisted
// operator wallet. Pattern lifted from V1's
// indexer/ops/ops.service.ts:38-65 (the GUARD half — the V1 OpsService's
// JSON-envelope tx-builder is NOT carried over; see Locked decision §Ops
// controller and the B6 bug docs).
//
// Wire contract:
//   Body must include: { signerPubkey, signedMessage, signatureB58, params? }
//   `signedMessage` is the verbatim string the operator signed; we
//   re-construct the canonical form server-side and compare to ensure the
//   client can't tamper:
//
//     canonical = `${domain}|${action}|${nonce}|${JSON.stringify(params)}`
//
//   The operator's nacl-signed bytes are sha256(canonical) — clients must
//   produce that or this guard rejects.
//
// Nonce: the body's `nonce` field — the client supplies a random one per
// request. The server rejects nonces seen in the last 24h (in-memory LRU,
// best-effort). Domain prevents cross-domain replay.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PrismaService } from "../prisma/prisma.service";

const NONCE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class OperatorAuthGuard implements CanActivate {
  private readonly nonceCache = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) throw new UnauthorizedException("empty body");

    const signerPubkey = body["signerPubkey"];
    const signedMessage = body["signedMessage"];
    const signatureB58 = body["signatureB58"];
    const nonce = body["nonce"];
    if (
      typeof signerPubkey !== "string" ||
      typeof signedMessage !== "string" ||
      typeof signatureB58 !== "string" ||
      typeof nonce !== "string"
    ) {
      throw new UnauthorizedException(
        "missing one of: signerPubkey, signedMessage, signatureB58, nonce"
      );
    }

    // Allowlist
    const allowed = await this.prisma.v2OperatorAllowlist.findUnique({
      where: { walletPubkey: signerPubkey },
    });
    if (!allowed) {
      throw new UnauthorizedException(
        `operator ${signerPubkey} not in V2OperatorAllowlist`
      );
    }

    // Nonce reuse check
    const now = Date.now();
    this.purgeNonces(now);
    if (this.nonceCache.has(nonce)) {
      throw new UnauthorizedException("nonce reused within TTL");
    }

    // Verify ed25519 signature
    let pubkeyBytes: Uint8Array;
    let sigBytes: Uint8Array;
    try {
      pubkeyBytes = bs58.decode(signerPubkey);
      sigBytes = bs58.decode(signatureB58);
    } catch {
      throw new UnauthorizedException("invalid base58 in pubkey or signature");
    }
    if (pubkeyBytes.length !== 32) {
      throw new UnauthorizedException("pubkey is not 32 bytes");
    }
    if (sigBytes.length !== 64) {
      throw new UnauthorizedException("signature is not 64 bytes");
    }
    const messageBytes = new TextEncoder().encode(signedMessage);
    const ok = nacl.sign.detached.verify(messageBytes, sigBytes, pubkeyBytes);
    if (!ok) {
      throw new UnauthorizedException("signature did not verify");
    }

    // Reconstruct canonical form, ensure domain + action + nonce + params
    // match.
    const expectedDomain = this.config.getOrThrow<string>("OPERATOR_NACL_DOMAIN");
    const action = this.routeAction(context);
    const params = (body["params"] ?? null) as unknown;
    const canonical = `${expectedDomain}|${action}|${nonce}|${JSON.stringify(params ?? null)}`;
    if (signedMessage !== canonical) {
      throw new UnauthorizedException("signedMessage does not match canonical form");
    }

    this.nonceCache.set(nonce, now);
    return true;
  }

  private routeAction(context: ExecutionContext): string {
    const req = context.switchToHttp().getRequest();
    const path = (req.url ?? "") as string;
    // Strip leading /api/v2/ops/ and any querystring.
    const tail = path.replace(/^\/api\/v2\/ops\//, "").split("?")[0]!;
    return tail;
  }

  private purgeNonces(now: number): void {
    for (const [n, ts] of this.nonceCache) {
      if (now - ts > NONCE_TTL_MS) {
        this.nonceCache.delete(n);
      }
    }
  }
}
