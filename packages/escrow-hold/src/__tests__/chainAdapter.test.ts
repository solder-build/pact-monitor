import { describe, it, expect } from "vitest";
import { StubEscrowChainAdapter } from "../chainAdapter";
import type { EscrowRecord } from "../types";

const r: EscrowRecord = {
  callId: "c1",
  agentPubkey: "A",
  endpointSlug: "krexa-lending",
  heldPremiumLamports: "2000",
  outcome: "ok",
  state: "LOCKED",
  lockedAtIso: "2025-01-01T00:00:00.000Z",
  releaseDeadlineUnix: "100",
};

describe("StubEscrowChainAdapter", () => {
  it("lock records an op and returns a STUB tx id", async () => {
    const a = new StubEscrowChainAdapter();
    const { txId } = await a.lock(r);
    expect(txId).toBe("STUB-lock-c1");
    expect(a.ops).toEqual([{ op: "lock", callId: "c1", amountLamports: "2000", txId: "STUB-lock-c1" }]);
  });

  it("release credits the fan-out ledger", async () => {
    const a = new StubEscrowChainAdapter();
    const { txId } = await a.release(r);
    expect(txId).toBe("STUB-release-c1");
    expect(a.fanoutCredited.get("c1")).toBe("2000");
    expect(a.agentRefunded.has("c1")).toBe(false);
  });

  it("refund credits the agent ledger", async () => {
    const a = new StubEscrowChainAdapter();
    const { txId } = await a.refund(r);
    expect(txId).toBe("STUB-refund-c1");
    expect(a.agentRefunded.get("c1")).toBe("2000");
    expect(a.fanoutCredited.has("c1")).toBe(false);
  });

  it("every tx id is STUB-prefixed", async () => {
    const a = new StubEscrowChainAdapter();
    await a.lock(r);
    await a.release(r);
    await a.refund(r);
    expect(a.ops.every((o) => o.txId.startsWith("STUB-"))).toBe(true);
  });
});
