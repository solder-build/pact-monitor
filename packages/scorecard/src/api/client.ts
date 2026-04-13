export interface ProviderSummary {
  id: string;
  name: string;
  category: string;
  total_calls: number;
  failure_rate: number;
  avg_latency_ms: number;
  uptime: number;
  insurance_rate: number;
  tier: "RELIABLE" | "ELEVATED" | "HIGH_RISK";
  total_payment_amount: number;
  lost_payment_amount: number;
}

export interface ProviderDetail extends ProviderSummary {
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  failure_breakdown: Record<string, number>;
  top_endpoints: Array<{ endpoint: string; calls: number; failure_rate: number }>;
  payment_breakdown: Record<string, { calls: number; total_amount: number; lost_amount: number }>;
}

export interface TimeseriesPoint {
  bucket: string;
  calls: number;
  failures: number;
  failure_rate: number;
}

export interface TimeseriesData {
  provider_id: string;
  granularity: "hourly" | "daily";
  data: TimeseriesPoint[];
}

export interface AnalyticsSummary {
  total_sdk_requests: number;
  total_claims: number;
  total_claim_amount: number;
  total_refund_amount: number;
  claims_by_trigger: Record<string, number>;
  unique_agents: number;
  unique_providers: number;
}

export interface AnalyticsTimeseriesPoint {
  bucket: string;
  requests: number;
  claims: number;
  refund_amount: number;
}

export interface AnalyticsTimeseries {
  granularity: "hourly" | "daily";
  data: AnalyticsTimeseriesPoint[];
}

export interface PoolSummary {
  hostname: string;
  pda: string;
  totalDeposited: string;
  totalAvailable: string;
  totalPremiumsEarned: string;
  totalClaimsPaid: string;
  insuranceRateBps: number;
  maxCoveragePerCall: string;
  activePolicies: number;
  payoutsThisWindow: string;
  windowStart: string;
}

export interface PoolPositionInfo {
  underwriter: string;
  deposited: string;
  earnedPremiums: string;
  depositTimestamp: string;
}

export interface PoolClaimInfo {
  id: string;
  call_record_id: string;
  agent_id: string;
  trigger_type: string;
  refund_amount: number | string;
  tx_hash: string | null;
  settlement_slot: number | null;
  created_at: string;
}

export interface PoolDetail {
  pool: {
    hostname: string;
    totalDeposited: string;
    totalAvailable: string;
    totalPremiumsEarned: string;
    totalClaimsPaid: string;
    insuranceRateBps: number;
    activePolicies: number;
    payoutsThisWindow: string;
  };
  positions: PoolPositionInfo[];
  recentClaims: PoolClaimInfo[];
}

const BASE = "/api/v1";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  getProviders: () => get<ProviderSummary[]>("/providers"),
  getProvider: (id: string) => get<ProviderDetail>(`/providers/${id}`),
  getTimeseries: (id: string, granularity = "hourly", days = 7) =>
    get<TimeseriesData>(`/providers/${id}/timeseries?granularity=${granularity}&days=${days}`),
  getAnalyticsSummary: () => get<AnalyticsSummary>("/analytics/summary"),
  getAnalyticsTimeseries: (granularity = "daily", days = 7) =>
    get<AnalyticsTimeseries>(`/analytics/timeseries?granularity=${granularity}&days=${days}`),
  getPools: () => get<{ pools: PoolSummary[] }>("/pools").then((r) => r.pools),
  getPool: (hostname: string) =>
    get<PoolDetail>(`/pools/${encodeURIComponent(hostname)}`),
};

export async function getPools(): Promise<PoolSummary[]> {
  return api.getPools();
}

export async function getPool(hostname: string): Promise<PoolDetail> {
  return api.getPool(hostname);
}
