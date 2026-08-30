import { describe, it, expect } from "vitest";
import { isHoldMode } from "../types";

describe("isHoldMode", () => {
  it("is true only for hold mode", () => {
    expect(isHoldMode("hold")).toBe(true);
    expect(isHoldMode("refund")).toBe(false);
  });
});
