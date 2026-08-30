import { describe, it, expect } from "vitest";
import { SystemClock, FakeClock } from "../clock";

describe("SystemClock", () => {
  it("returns whole-second unix time and an ISO string", () => {
    const c = new SystemClock();
    const u = c.nowUnix();
    expect(Number.isInteger(u)).toBe(true);
    expect(u).toBeGreaterThan(1_600_000_000);
    expect(c.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("FakeClock", () => {
  it("starts at the given time, floored to whole seconds", () => {
    const c = new FakeClock(1000.9);
    expect(c.nowUnix()).toBe(1000);
    expect(c.nowIso()).toBe(new Date(1000 * 1000).toISOString());
  });

  it("set() jumps to an absolute time", () => {
    const c = new FakeClock(0);
    c.set(5000.7);
    expect(c.nowUnix()).toBe(5000);
  });

  it("advance() moves time forward", () => {
    const c = new FakeClock(100);
    c.advance(50);
    expect(c.nowUnix()).toBe(150);
  });
});
