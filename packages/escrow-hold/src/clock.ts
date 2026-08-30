// @pact-network/escrow-hold — clock abstraction.
//
// The hold→release/refund transition is time-gated (a deadline must pass).
// To keep the state machine deterministic and unit-testable WITHOUT sleeping
// real wall-clock time, all time reads go through this interface. Tests inject
// a FakeClock; the demo can use either.

export interface Clock {
  /** Current time in whole Unix seconds. */
  nowUnix(): number;
  /** Current time as an ISO-8601 string. */
  nowIso(): string;
}

/** Real wall-clock. Used in production wiring; never in tests. */
export class SystemClock implements Clock {
  nowUnix(): number {
    return Math.floor(Date.now() / 1000);
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

/**
 * Deterministic clock for tests and demos. Time only moves when you move it,
 * so a "48h hold window" can be exercised in microseconds.
 */
export class FakeClock implements Clock {
  private unix: number;
  constructor(startUnix: number) {
    this.unix = Math.floor(startUnix);
  }
  nowUnix(): number {
    return this.unix;
  }
  nowIso(): string {
    return new Date(this.unix * 1000).toISOString();
  }
  /** Set absolute time (whole Unix seconds). */
  set(unix: number): void {
    this.unix = Math.floor(unix);
  }
  /** Advance by N seconds. */
  advance(seconds: number): void {
    this.unix += Math.floor(seconds);
  }
}
