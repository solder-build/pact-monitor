import { describe, it, expect } from "vitest";
import type { Outcome } from "@pact-network/wrap";
import { isBreachOutcome, deterministicVerdictHook } from "../verdictHook";
import type { EscrowRecord } from "../types";

function record(outcome: Outcome): EscrowRecord {
  return {
    callId: "c1",
    agentPubkey: "A",
    endpointSlug: "krexa-lending",
    heldPremiumLamports: "2000",
    outcome,
    state: "LOCKED",
    lockedAtIso: "2025-01-01T00:00:00.000Z",
    releaseDeadlineUnix: "1750000000",
  };
}

describe("isBreachOutcome", () => {
  it("treats only 'ok' as non-breach", () => {
    expect(isBreachOutcome("ok")).toBe(false);
    const breaches: Outcome[] = ["latency_breach", "server_error", "client_error", "network_error"];
    for (const o of breaches) {
      expect(isBreachOutcome(o)).toBe(true);
    }
  });
});

describe("deterministicVerdictHook", () => {
  it("releases on ok", () => {
    const v = deterministicVerdictHook.decide(record("ok"));
    expect(v).toEqual({ action: "release", breach: false, source: "deterministic", stubbed: true });
  });

  it("refunds on a covered breach", () => {
    const v = deterministicVerdictHook.decide(record("server_error"));
    expect(v).toEqual({ action: "refund", breach: true, source: "deterministic", stubbed: true });
  });
});
