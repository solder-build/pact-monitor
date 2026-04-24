/**
 * WP-18: Error-code regex round-trip test.
 *
 * Pinocchio emits the same log format as Anchor for custom program errors:
 *   "Program X failed: custom program error: 0x17XX"
 *
 * The hex encoding of 6000..=6030 (0x1770..=0x178E) must survive the
 * migration — backend parsers that regex-match on this format must still
 * work after the Anchor → Pinocchio swap.
 *
 * This test:
 *  1. Encodes every error code 6000..=6030 into the Pinocchio/RPC log format.
 *  2. Runs the same regex the backend (and SDK) would use to extract the code.
 *  3. Asserts the round-trip is lossless (parsed hex → decimal === original code).
 *
 * No validator is required — this is pure string-format verification.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The log line Pinocchio (and Anchor) produce when a custom error fires.
// Anchor docs + RPC confirmed: "Program <pubkey> failed: custom program error: 0x<hex>"
function fmtCustomError(programId: string, code: number): string {
  return `Program ${programId} failed: custom program error: 0x${code.toString(16)}`;
}

// The regex a backend log parser would use to extract the numeric error code.
const CUSTOM_ERROR_RE = /custom program error: 0x([0-9a-f]+)/i;

function parseErrorCode(logLine: string): number | null {
  const m = CUSTOM_ERROR_RE.exec(logLine);
  if (!m) return null;
  return parseInt(m[1], 16);
}

const PROGRAM_ID = "2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3";

// First and last codes from the 6000..=6030 range (31 variants, WP-2).
const BOUNDARY_CODES = [6000, 6001, 6017, 6025, 6027, 6028, 6029, 6030];

describe("error-code regex round-trip (WP-18)", () => {
  it("regex extracts all 31 error codes 6000..=6030 from Pinocchio log format", () => {
    for (let code = 6000; code <= 6030; code++) {
      const line = fmtCustomError(PROGRAM_ID, code);
      const parsed = parseErrorCode(line);
      assert.equal(
        parsed,
        code,
        `code ${code} (0x${code.toString(16)}): expected ${code}, got ${parsed} from: ${line}`,
      );
    }
  });

  it("6017 (Unauthorized) round-trips — representative mid-range code", () => {
    const code = 6017;
    // 6017 decimal = 0x1781
    const line = fmtCustomError(PROGRAM_ID, code);
    assert.match(line, /0x1781/);
    const parsed = parseErrorCode(line);
    assert.equal(parsed, 6017);
  });

  it("6000 (first variant) encodes as 0x1770", () => {
    const line = fmtCustomError(PROGRAM_ID, 6000);
    assert.match(line, /0x1770/);
    assert.equal(parseErrorCode(line), 6000);
  });

  it("6030 (last variant) encodes as 0x178e", () => {
    const line = fmtCustomError(PROGRAM_ID, 6030);
    assert.match(line, /0x178e/);
    assert.equal(parseErrorCode(line), 6030);
  });

  it("boundary codes all round-trip", () => {
    for (const code of BOUNDARY_CODES) {
      const parsed = parseErrorCode(fmtCustomError(PROGRAM_ID, code));
      assert.equal(parsed, code, `boundary code ${code} failed round-trip`);
    }
  });

  it("regex does not match unrelated log lines", () => {
    assert.equal(parseErrorCode("Program X succeeded"), null);
    assert.equal(parseErrorCode("Program X failed: insufficient funds"), null);
    assert.equal(parseErrorCode("custom program error without hex"), null);
  });

  it("regex is case-insensitive for hex digits A-F", () => {
    // 6030 = 0x178e — contains a lowercase letter; test uppercase form too.
    const lineUpper = `Program ${PROGRAM_ID} failed: custom program error: 0x178E`;
    assert.equal(parseErrorCode(lineUpper), 6030);
  });
});
