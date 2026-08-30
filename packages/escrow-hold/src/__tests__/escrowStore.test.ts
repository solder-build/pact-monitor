import { describe, it, expect } from "vitest";
import { InMemoryEscrowStore } from "../escrowStore";
import type { EscrowRecord } from "../types";

function rec(callId: string, deadline: string, state: EscrowRecord["state"] = "LOCKED"): EscrowRecord {
  return {
    callId,
    agentPubkey: "A",
    endpointSlug: "krexa-lending",
    heldPremiumLamports: "2000",
    outcome: "ok",
    state,
    lockedAtIso: "2025-01-01T00:00:00.000Z",
    releaseDeadlineUnix: deadline,
  };
}

describe("InMemoryEscrowStore", () => {
  it("put + get round-trips and returns a copy (no aliasing)", () => {
    const s = new InMemoryEscrowStore();
    const r = rec("c1", "100");
    s.put(r);
    const got = s.get("c1")!;
    expect(got).toEqual(r);
    got.state = "RELEASED";
    expect(s.get("c1")!.state).toBe("LOCKED"); // external mutation didn't leak in
  });

  it("get returns undefined for unknown id", () => {
    expect(new InMemoryEscrowStore().get("nope")).toBeUndefined();
  });

  it("put throws on duplicate callId", () => {
    const s = new InMemoryEscrowStore();
    s.put(rec("c1", "100"));
    expect(() => s.put(rec("c1", "100"))).toThrow(/already exists/);
  });

  it("setState updates state and optional txId; throws if missing", () => {
    const s = new InMemoryEscrowStore();
    s.put(rec("c1", "100"));
    s.setState("c1", "RELEASED", "STUB-release-c1");
    expect(s.get("c1")!.state).toBe("RELEASED");
    expect(s.get("c1")!.finalizeTxId).toBe("STUB-release-c1");

    s.put(rec("c2", "100"));
    s.setState("c2", "REFUNDED"); // no txId
    expect(s.get("c2")!.state).toBe("REFUNDED");
    expect(s.get("c2")!.finalizeTxId).toBeUndefined();

    expect(() => s.setState("missing", "RELEASED")).toThrow(/no escrow record/);
  });

  it("all() returns every record as copies", () => {
    const s = new InMemoryEscrowStore();
    s.put(rec("c1", "100"));
    s.put(rec("c2", "200"));
    expect(s.all().map((r) => r.callId).sort()).toEqual(["c1", "c2"]);
  });

  it("dueForCrank returns only LOCKED records at/under now", () => {
    const s = new InMemoryEscrowStore();
    s.put(rec("due-eq", "100"));
    s.put(rec("due-past", "50"));
    s.put(rec("not-due", "200"));
    s.put(rec("released", "10", "RELEASED")); // terminal, excluded even though past
    const due = s.dueForCrank(100).map((r) => r.callId).sort();
    expect(due).toEqual(["due-eq", "due-past"]);
  });
});
