// @pact-network/escrow-hold — on-chain adapter (STUBBED in the PoC).
//
// In production this would issue the actual instructions against the Pact
// program: hold the premium (increment the CoveragePool `held_premiums`
// counter), then on verdict either release it to the fan-out or refund the
// agent. Release/refund are signed by the existing CoveragePool /
// SettlementAuthority PDAs via `invoke_signed` — the same trust model the
// settler already uses.
//
// For the PoC there is NO real chain. StubEscrowChainAdapter returns `STUB-`
// tx ids and tracks an in-memory ledger so demos/tests can assert WHERE the
// money would have gone. Nothing here touches a real ATA or pool.

import type { EscrowRecord } from "./types";

export interface EscrowChainAdapter {
  /** Hold the premium (PoC: record-only). Returns a (stub) tx id. */
  lock(record: EscrowRecord): Promise<{ txId: string }>;
  /** Release the held premium to the normal fan-out. Returns a (stub) tx id. */
  release(record: EscrowRecord): Promise<{ txId: string }>;
  /** Refund the held premium to the agent. Returns a (stub) tx id. */
  refund(record: EscrowRecord): Promise<{ txId: string }>;
}

/** One recorded adapter operation, for test/demo assertions. */
export interface AdapterOp {
  op: "lock" | "release" | "refund";
  callId: string;
  amountLamports: string;
  txId: string;
}

/**
 * In-memory stub. Tracks every op and a per-callId ledger of where funds
 * landed (fan-out vs agent). Every tx id is prefixed `STUB-` so no output can
 * be mistaken for a real on-chain settlement.
 */
export class StubEscrowChainAdapter implements EscrowChainAdapter {
  readonly ops: AdapterOp[] = [];
  /** callId → premium amount released to the normal fan-out. */
  readonly fanoutCredited = new Map<string, string>();
  /** callId → premium amount refunded to the agent. */
  readonly agentRefunded = new Map<string, string>();

  async lock(record: EscrowRecord): Promise<{ txId: string }> {
    const txId = `STUB-lock-${record.callId}`;
    this.ops.push({ op: "lock", callId: record.callId, amountLamports: record.heldPremiumLamports, txId });
    return { txId };
  }

  async release(record: EscrowRecord): Promise<{ txId: string }> {
    const txId = `STUB-release-${record.callId}`;
    this.fanoutCredited.set(record.callId, record.heldPremiumLamports);
    this.ops.push({ op: "release", callId: record.callId, amountLamports: record.heldPremiumLamports, txId });
    return { txId };
  }

  async refund(record: EscrowRecord): Promise<{ txId: string }> {
    const txId = `STUB-refund-${record.callId}`;
    this.agentRefunded.set(record.callId, record.heldPremiumLamports);
    this.ops.push({ op: "refund", callId: record.callId, amountLamports: record.heldPremiumLamports, txId });
    return { txId };
  }
}
