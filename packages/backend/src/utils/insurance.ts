export type Tier = "RELIABLE" | "ELEVATED" | "HIGH_RISK";

export function computeInsuranceRate(failureRate: number): number {
  return Math.max(0.001, failureRate * 1.5 + 0.001);
}

export function computeTier(insuranceRate: number): Tier {
  if (insuranceRate < 0.01) return "RELIABLE";
  if (insuranceRate <= 0.05) return "ELEVATED";
  return "HIGH_RISK";
}
