// @pact-network/escrow-hold — escrow record store.
//
// Abstracts persistence of escrow records. The PoC ships an in-memory store;
// a production implementation would back this with the indexer DB and mirror
// the on-chain `held_premiums` counter on the CoveragePool.

import type { EscrowRecord, EscrowState } from "./types";

export interface EscrowStore {
  /** Insert a new record. Throws if callId already exists. */
  put(record: EscrowRecord): void;
  /** Fetch a record by callId, or undefined. */
  get(callId: string): EscrowRecord | undefined;
  /** Set the terminal state (+ optional finalize tx id). Throws if missing. */
  setState(callId: string, state: EscrowState, finalizeTxId?: string): void;
  /** All records (insertion order). */
  all(): EscrowRecord[];
  /**
   * Records still LOCKED whose `releaseDeadlineUnix <= nowUnix`. These are the
   * records a (permissionless) crank may finalize.
   */
  dueForCrank(nowUnix: number): EscrowRecord[];
}

export class InMemoryEscrowStore implements EscrowStore {
  private readonly records = new Map<string, EscrowRecord>();

  put(record: EscrowRecord): void {
    if (this.records.has(record.callId)) {
      throw new Error(`escrow record already exists for callId ${record.callId}`);
    }
    // Defensive copy so external mutation can't corrupt the store.
    this.records.set(record.callId, { ...record });
  }

  get(callId: string): EscrowRecord | undefined {
    const r = this.records.get(callId);
    return r ? { ...r } : undefined;
  }

  setState(callId: string, state: EscrowState, finalizeTxId?: string): void {
    const r = this.records.get(callId);
    if (!r) {
      throw new Error(`no escrow record for callId ${callId}`);
    }
    r.state = state;
    if (finalizeTxId !== undefined) {
      r.finalizeTxId = finalizeTxId;
    }
  }

  all(): EscrowRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  dueForCrank(nowUnix: number): EscrowRecord[] {
    return [...this.records.values()]
      .filter((r) => r.state === "LOCKED" && BigInt(r.releaseDeadlineUnix) <= BigInt(Math.floor(nowUnix)))
      .map((r) => ({ ...r }));
  }
}
