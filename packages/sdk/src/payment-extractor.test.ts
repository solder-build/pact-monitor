import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPaymentData, enrichWithManualAmount } from "./payment-extractor.js";

describe("extractPaymentData", () => {
  it("returns x402 data when PAYMENT-RESPONSE header present", () => {
    const payload = { network: "solana", payer: "abc123", transaction: "tx456", success: true };
    const encoded = btoa(JSON.stringify(payload));
    const headers = new Headers({ "PAYMENT-RESPONSE": encoded });

    const result = extractPaymentData(headers);
    assert.notEqual(result, null);
    assert.equal(result!.protocol, "x402");
    assert.equal(result!.network, "solana");
    assert.equal(result!.payerAddress, "abc123");
    assert.equal(result!.txHash, "tx456");
    assert.equal(result!.settlementSuccess, true);
  });

  it("returns MPP data when Payment-Receipt header present", () => {
    const payload = { tx: "mpp_tx_789", status: "settled" };
    const encoded = btoa(JSON.stringify(payload));
    const headers = new Headers({ "Payment-Receipt": encoded });

    const result = extractPaymentData(headers);
    assert.notEqual(result, null);
    assert.equal(result!.protocol, "mpp");
    assert.equal(result!.txHash, "mpp_tx_789");
    assert.equal(result!.settlementSuccess, true);
  });

  it("returns null when no payment headers", () => {
    const headers = new Headers({ "Content-Type": "application/json" });
    const result = extractPaymentData(headers);
    assert.equal(result, null);
  });

  it("returns null when header contains invalid base64/JSON (does not throw)", () => {
    const headers = new Headers({ "PAYMENT-RESPONSE": "not-valid-base64!!!" });
    const result = extractPaymentData(headers);
    assert.equal(result, null);
  });
});

describe("enrichWithManualAmount", () => {
  it("creates payment from manual usdcAmount when no header data", () => {
    const result = enrichWithManualAmount(null, 0.5);
    assert.notEqual(result, null);
    assert.equal(result!.protocol, "x402");
    assert.equal(result!.amount, 500_000);
    assert.equal(result!.asset, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.equal(result!.network, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    assert.equal(result!.settlementSuccess, true);
  });

  it("fills in amount on existing payment when amount is 0", () => {
    const existing = {
      protocol: "x402" as const,
      amount: 0,
      asset: "",
      network: "solana",
      payerAddress: "payer1",
      recipientAddress: "",
      txHash: "tx1",
      settlementSuccess: true,
    };
    const result = enrichWithManualAmount(existing, 1.25);
    assert.notEqual(result, null);
    assert.equal(result!.amount, 1_250_000);
    assert.equal(result!.asset, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.equal(result!.payerAddress, "payer1");
  });

  it("returns null when no payment and no manual amount", () => {
    const result = enrichWithManualAmount(null);
    assert.equal(result, null);
  });

  // --- Bad-case validation: these tests exist because a prior version of
  // the sample demo passed lamports (2_000_000) instead of whole USDC (2)
  // and the scorecard rendered a "2000000.00 USDC" refund row. The SDK
  // now rejects pathological values loudly.

  it("throws on NaN usdcAmount", () => {
    assert.throws(() => enrichWithManualAmount(null, NaN), RangeError);
  });

  it("throws on Infinity usdcAmount", () => {
    assert.throws(() => enrichWithManualAmount(null, Infinity), RangeError);
  });

  it("throws on negative usdcAmount", () => {
    assert.throws(() => enrichWithManualAmount(null, -1), RangeError);
  });

  it("throws on unreasonably large usdcAmount (unit mistake guard)", () => {
    // Attempting to pass lamports (2_000_000) as whole USDC should blow up,
    // not silently mint a 2-million-dollar billing record.
    assert.throws(
      () => enrichWithManualAmount(null, 2_000_000),
      /exceeds MAX_MANUAL_USDC_PER_CALL/,
    );
  });

  it("accepts the boundary value MAX_MANUAL_USDC_PER_CALL", () => {
    const result = enrichWithManualAmount(null, 1_000_000);
    assert.notEqual(result, null);
    assert.equal(result!.amount, 1_000_000 * 1_000_000);
  });

  it("accepts 0 usdcAmount (free call)", () => {
    // 0 with no existing payment returns null (no billing record at all)
    const result = enrichWithManualAmount(null, 0);
    assert.equal(result, null);
  });

  it("throws on non-number usdcAmount types", () => {
    assert.throws(
      () => enrichWithManualAmount(null, "2" as unknown as number),
      RangeError,
    );
  });
});
