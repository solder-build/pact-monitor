import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { OperatorAuthGuard } from "./operator-auth.guard";

function fakeConfig(domain = "test-domain"): any {
  return {
    getOrThrow: (k: string) => (k === "OPERATOR_NACL_DOMAIN" ? domain : undefined),
  };
}

function fakePrisma(allowed: string[]): any {
  return {
    v2OperatorAllowlist: {
      findUnique: vi.fn(async ({ where }: any) =>
        allowed.includes(where.walletPubkey)
          ? { walletPubkey: where.walletPubkey, addedAt: new Date() }
          : null
      ),
    },
  };
}

function buildContext(req: any): any {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  };
}

function sign(message: string, keypair: nacl.SignKeyPair): string {
  const sig = nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey);
  return bs58.encode(sig);
}

describe("OperatorAuthGuard", () => {
  const kp = nacl.sign.keyPair();
  const signerPubkey = bs58.encode(kp.publicKey);

  it("allows a well-formed signed request from an allowlisted operator", async () => {
    const guard = new OperatorAuthGuard(
      fakeConfig() as any,
      fakePrisma([signerPubkey]) as any
    );
    const params = { paused: true };
    const action = "pause";
    const nonce = "nonce-1";
    const canonical = `test-domain|${action}|${nonce}|${JSON.stringify(params)}`;
    const signatureB58 = sign(canonical, kp);
    const req = {
      url: `/api/v2/ops/${action}`,
      body: {
        signerPubkey,
        signedMessage: canonical,
        signatureB58,
        nonce,
        params,
      },
    };
    await expect(guard.canActivate(buildContext(req))).resolves.toBe(true);
  });

  it("rejects when operator not in allowlist", async () => {
    const guard = new OperatorAuthGuard(
      fakeConfig() as any,
      fakePrisma([]) as any
    );
    const canonical = "test-domain|pause|n1|null";
    const sigB58 = sign(canonical, kp);
    const req = {
      url: "/api/v2/ops/pause",
      body: {
        signerPubkey,
        signedMessage: canonical,
        signatureB58: sigB58,
        nonce: "n1",
        params: null,
      },
    };
    await expect(guard.canActivate(buildContext(req))).rejects.toThrow(
      /not in V2OperatorAllowlist/
    );
  });

  it("rejects when signedMessage doesn't match canonical form", async () => {
    const guard = new OperatorAuthGuard(
      fakeConfig() as any,
      fakePrisma([signerPubkey]) as any
    );
    const tamperedMessage = "test-domain|pause|n2|{\"paused\":false}";
    const sigB58 = sign(tamperedMessage, kp);
    const req = {
      url: "/api/v2/ops/pause",
      body: {
        signerPubkey,
        signedMessage: tamperedMessage,
        signatureB58: sigB58,
        nonce: "n2",
        params: { paused: true }, // client claims true, signed false → mismatch
      },
    };
    await expect(guard.canActivate(buildContext(req))).rejects.toThrow(
      /does not match canonical/
    );
  });

  it("rejects invalid signature", async () => {
    const guard = new OperatorAuthGuard(
      fakeConfig() as any,
      fakePrisma([signerPubkey]) as any
    );
    const canonical = "test-domain|pause|n3|null";
    const otherKp = nacl.sign.keyPair();
    const sigB58 = sign(canonical, otherKp); // wrong key
    const req = {
      url: "/api/v2/ops/pause",
      body: {
        signerPubkey,
        signedMessage: canonical,
        signatureB58: sigB58,
        nonce: "n3",
        params: null,
      },
    };
    await expect(guard.canActivate(buildContext(req))).rejects.toThrow(
      /signature did not verify/
    );
  });

  it("rejects nonce reuse", async () => {
    const guard = new OperatorAuthGuard(
      fakeConfig() as any,
      fakePrisma([signerPubkey]) as any
    );
    const canonical = "test-domain|pause|n4|null";
    const sigB58 = sign(canonical, kp);
    const req = {
      url: "/api/v2/ops/pause",
      body: {
        signerPubkey,
        signedMessage: canonical,
        signatureB58: sigB58,
        nonce: "n4",
        params: null,
      },
    };
    await expect(guard.canActivate(buildContext(req))).resolves.toBe(true);
    await expect(guard.canActivate(buildContext(req))).rejects.toThrow(
      /nonce reused/
    );
  });

  it("rejects missing body fields", async () => {
    const guard = new OperatorAuthGuard(
      fakeConfig() as any,
      fakePrisma([signerPubkey]) as any
    );
    const req = { url: "/api/v2/ops/pause", body: { signerPubkey } };
    await expect(guard.canActivate(buildContext(req))).rejects.toThrow(
      /missing one of/
    );
  });
});
