import type { PaymentData } from "./types.js";

export function extractPaymentData(headers: Headers): PaymentData | null {
  try {
    const x402Data = extractX402(headers);
    if (x402Data) return x402Data;

    const mppData = extractMpp(headers);
    if (mppData) return mppData;

    return null;
  } catch {
    return null;
  }
}

function extractX402(headers: Headers): PaymentData | null {
  const raw = headers.get("PAYMENT-RESPONSE") || headers.get("payment-response");
  if (!raw) return null;

  const decoded = JSON.parse(atob(raw));

  return {
    protocol: "x402",
    amount: 0, // amount comes from PAYMENT-REQUIRED on the 402 response, not the final response
    asset: "",
    network: decoded.network || "",
    payerAddress: decoded.payer || "",
    recipientAddress: "",
    txHash: decoded.transaction || "",
    settlementSuccess: decoded.success ?? true,
  };
}

function extractMpp(headers: Headers): PaymentData | null {
  const raw = headers.get("Payment-Receipt") || headers.get("payment-receipt");
  if (!raw) return null;

  const decoded = JSON.parse(atob(raw));

  return {
    protocol: "mpp",
    amount: 0,
    asset: "",
    network: "",
    payerAddress: "",
    recipientAddress: "",
    txHash: decoded.tx || decoded.transaction || "",
    settlementSuccess: decoded.status === "settled",
  };
}

// Upper bound on manually-declared per-call cost. Anything above this is
// almost certainly a unit mistake (passing lamports instead of whole USDC).
// At $1M per single API call, even the most expensive enterprise inference
// request is orders of magnitude under this ceiling. Throwing here prevents
// silently drowning the agent's wallet via downstream premium settlement.
export const MAX_MANUAL_USDC_PER_CALL = 1_000_000; // one million USDC

export function enrichWithManualAmount(
  payment: PaymentData | null,
  usdcAmount?: number,
): PaymentData | null {
  if (usdcAmount !== undefined) {
    if (typeof usdcAmount !== "number" || !Number.isFinite(usdcAmount)) {
      throw new RangeError(
        `pactOptions.usdcAmount must be a finite number (got ${typeof usdcAmount === "number" ? usdcAmount : typeof usdcAmount})`,
      );
    }
    if (usdcAmount < 0) {
      throw new RangeError(
        `pactOptions.usdcAmount must be non-negative (got ${usdcAmount})`,
      );
    }
    if (usdcAmount > MAX_MANUAL_USDC_PER_CALL) {
      throw new RangeError(
        `pactOptions.usdcAmount ${usdcAmount} exceeds MAX_MANUAL_USDC_PER_CALL (${MAX_MANUAL_USDC_PER_CALL}). ` +
          `This value is in WHOLE USDC — did you accidentally pass lamports?`,
      );
    }
  }

  if (!payment && !usdcAmount) return null;

  if (!payment && usdcAmount) {
    return {
      protocol: "x402",
      amount: Math.round(usdcAmount * 1_000_000),
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      payerAddress: "",
      recipientAddress: "",
      txHash: "",
      settlementSuccess: true,
    };
  }

  if (payment && usdcAmount && payment.amount === 0) {
    payment.amount = Math.round(usdcAmount * 1_000_000);
    payment.asset = payment.asset || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  }

  return payment;
}
