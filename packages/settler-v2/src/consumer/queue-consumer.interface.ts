// Backend-agnostic queue consumer interface — identical contract to V1
// settler. The on-the-wire payload type changes (V2SettlementEvent
// instead of V1's SettlementEvent) but the queue plumbing does not.

export interface SettleMessage {
  /** Backend message ID (Pub/Sub message ID, Redis stream entry ID). */
  id: string;
  /** Parsed JSON payload — a V2SettlementEvent published by the proxy. */
  data: Record<string, unknown>;
  /** Acknowledge to the backend. Idempotent — calling twice is a no-op. */
  ack(): void;
  /** Negatively acknowledge — release for redelivery. */
  nack(): void;
}

export interface QueueConsumer {
  init(): void | Promise<void>;
  destroy(): void | Promise<void>;
  setEnqueueCallback(cb: (msg: SettleMessage) => void): void;
  drain(): SettleMessage[];
  readonly queueLength: number;
  ack(messages: SettleMessage[]): void;
  nack(messages: SettleMessage[]): void;
}
