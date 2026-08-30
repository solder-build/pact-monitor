import { describe, expect, it } from "vitest";
import {
  PROTOCOL_V2_ERRORS,
  decodeProtocolError,
  formatProtocolError,
  tryExtractProtocolError,
} from "../src/errors.js";

describe("PROTOCOL_V2_ERRORS", () => {
  it("covers contiguous 6000..6030 with no gaps", () => {
    for (let code = 6000; code <= 6030; code++) {
      const e = PROTOCOL_V2_ERRORS[code];
      expect(e, `missing code ${code}`).toBeDefined();
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  it("does not define codes outside 6000..6030", () => {
    expect(PROTOCOL_V2_ERRORS[5999]).toBeUndefined();
    expect(PROTOCOL_V2_ERRORS[6031]).toBeUndefined();
  });

  it("does NOT carry V1 names — 6000 is ProtocolPaused (not InsufficientBalance)", () => {
    expect(PROTOCOL_V2_ERRORS[6000].name).toBe("ProtocolPaused");
  });

  it("pins WP-12 referrer error names per critique tail", () => {
    expect(PROTOCOL_V2_ERRORS[6014].name).toBe("InvalidRate");
    expect(PROTOCOL_V2_ERRORS[6027].name).toBe("RateOutOfBounds");
    expect(PROTOCOL_V2_ERRORS[6028].name).toBe("RateBelowFloor");
  });

  it("pins the C-01/C-02 authority error names", () => {
    expect(PROTOCOL_V2_ERRORS[6024].name).toBe("UnauthorizedDeployer");
    expect(PROTOCOL_V2_ERRORS[6025].name).toBe("UnauthorizedOracle");
    expect(PROTOCOL_V2_ERRORS[6026].name).toBe("FrozenConfigField");
    expect(PROTOCOL_V2_ERRORS[6030].name).toBe("InvalidOracleKey");
  });
});

describe("decodeProtocolError", () => {
  it("returns the entry for known codes", () => {
    const e = decodeProtocolError(6018);
    expect(e?.name).toBe("Unauthorized");
  });

  it("returns undefined for unknown codes", () => {
    expect(decodeProtocolError(7000)).toBeUndefined();
    expect(decodeProtocolError(0)).toBeUndefined();
  });
});

describe("formatProtocolError", () => {
  it("formats known codes as Name (code): message", () => {
    const s = formatProtocolError(6018);
    expect(s).toMatch(/^Unauthorized \(6018\): /);
  });

  it("falls back to a Custom() string for unknown codes", () => {
    expect(formatProtocolError(7000)).toBe("Custom(7000): unknown error");
  });
});

describe("tryExtractProtocolError", () => {
  it("walks nested InstructionError shapes", () => {
    const err = {
      InstructionError: [0, { Custom: 6018 }],
    };
    const e = tryExtractProtocolError(err);
    expect(e?.code).toBe(6018);
    expect(e?.name).toBe("Unauthorized");
  });

  it("walks arrays inside nested objects", () => {
    const err = { transactionError: [{ Custom: 6027 }] };
    expect(tryExtractProtocolError(err)?.code).toBe(6027);
  });

  it("returns an Unknown stub for codes outside the V2 map", () => {
    const err = { InstructionError: [0, { Custom: 7777 }] };
    const e = tryExtractProtocolError(err);
    expect(e?.code).toBe(7777);
    expect(e?.name).toBe("Unknown");
  });

  it("returns undefined for non-objects and for objects with no Custom", () => {
    expect(tryExtractProtocolError(null)).toBeUndefined();
    expect(tryExtractProtocolError("oops")).toBeUndefined();
    expect(tryExtractProtocolError({ foo: "bar" })).toBeUndefined();
  });

  it("handles cyclic references without stack-overflow", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a.b = b;
    // No Custom present → undefined; should not loop forever.
    expect(tryExtractProtocolError(a)).toBeUndefined();
  });
});
