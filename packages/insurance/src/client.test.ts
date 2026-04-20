import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { PactInsurance } from "./client.js";
import { createAnchorClient } from "./anchor-client.js";

describe("createAnchorClient programId override", () => {
  it("uses opts.programId rather than the address embedded in the bundled IDL", () => {
    // A valid base58 pubkey that differs from the IDL's embedded devnet
    // address (2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3). If the IDL's
    // address leaks through, program.programId will NOT match this value.
    const overrideId = "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob";
    const kp = Keypair.generate();
    const client = createAnchorClient({
      rpcUrl: "http://127.0.0.1:8899",
      programId: overrideId,
      agentKeypair: kp,
    });
    assert.equal(client.programId.toBase58(), overrideId);
    assert.equal(client.program.programId.toBase58(), overrideId);
  });
});

describe("PactInsurance.submitClaim", () => {
  it("sends Authorization: Bearer header when apiKey is configured", async () => {
    const kp = Keypair.generate();
    const insurance = new PactInsurance(
      {
        rpcUrl: "http://127.0.0.1:8899",
        programId: "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob",
        backendUrl: "http://backend.test",
        apiKey: "pact_test_key",
      },
      kp,
    );

    let capturedHeaders: Record<string, string> | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url: unknown, init: RequestInit | undefined) => {
      capturedHeaders = init!.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ signature: "x", slot: 1, refundAmount: 0 }),
        { status: 200 },
      );
    };
    try {
      await insurance.submitClaim("example.com", "call-id-1");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(capturedHeaders?.Authorization, "Bearer pact_test_key");
  });

  it("does NOT send Authorization header when apiKey is omitted", async () => {
    const kp = Keypair.generate();
    const insurance = new PactInsurance(
      {
        rpcUrl: "http://127.0.0.1:8899",
        programId: "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob",
        backendUrl: "http://backend.test",
      },
      kp,
    );

    let capturedHeaders: Record<string, string> | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url: unknown, init: RequestInit | undefined) => {
      capturedHeaders = init!.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ signature: "x", slot: 1, refundAmount: 0 }),
        { status: 200 },
      );
    };
    try {
      await insurance.submitClaim("example.com", "call-id-1");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(capturedHeaders?.Authorization, undefined);
  });

  it("does NOT send Authorization header when apiKey is whitespace-only", async () => {
    const kp = Keypair.generate();
    const insurance = new PactInsurance(
      {
        rpcUrl: "http://127.0.0.1:8899",
        programId: "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob",
        backendUrl: "http://backend.test",
        apiKey: "   ",
      },
      kp,
    );

    let capturedHeaders: Record<string, string> | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url: unknown, init: RequestInit | undefined) => {
      capturedHeaders = init!.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ signature: "x", slot: 1, refundAmount: 0 }),
        { status: 200 },
      );
    };
    try {
      await insurance.submitClaim("example.com", "call-id-1");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(capturedHeaders?.Authorization, undefined);
  });
});
