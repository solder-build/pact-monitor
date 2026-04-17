const BASE = "/api/v1/admin";

function getToken(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") || "";
}

async function adminGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(`Admin API error: ${res.status}`);
  return res.json();
}

export interface OverviewData {
  total_records: number;
  total_providers: number;
  unique_agents: number;
  total_payment_volume: number;
  total_lost_value: number;
  settlement_rate: number;
}

export interface RouteHealth {
  route: string;
  requests: number;
  errors: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}

export interface IngestionPoint {
  bucket: string;
  records: number;
}

export interface AgentDay {
  day: string;
  active_agents: number;
  new_agents: number;
}

export interface AgentsData {
  daily: AgentDay[];
  retention_rate: number;
}

export interface ScorecardUsageData {
  hourly: Array<{ bucket: string; views: number }>;
  total_views: number;
  unique_sessions: number;
  provider_clicks: number;
  click_through_rate: number;
}

export interface CostRow {
  provider: string;
  total_calls: number;
  paid_calls: number;
  avg_payment_micro_usdc: number;
  total_paid: number;
  total_lost: number;
  settlement_failures: number;
}

export interface FlagRow {
  id: string;
  agent_id: string;
  agent_pubkey: string | null;
  flag_reason: string;
  flag_data: Record<string, unknown>;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  records_24h: number;
  claims_24h: number;
}

async function adminPatch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Admin PATCH ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const adminApi = {
  getOverview: () => adminGet<OverviewData>("/overview"),
  getBackendHealth: () => adminGet<RouteHealth[]>("/backend-health"),
  getIngestion: () => adminGet<IngestionPoint[]>("/ingestion"),
  getAgents: () => adminGet<AgentsData>("/agents"),
  getScorecardUsage: () => adminGet<ScorecardUsageData>("/scorecard-usage"),
  getCosts: () => adminGet<CostRow[]>("/costs"),
  getFlags: (status?: string) =>
    adminGet<FlagRow[]>(status ? `/flags?status=${status}` : "/flags"),
  resolveFlag: (id: string, status: "dismissed" | "suspended") =>
    adminPatch<{ ok: boolean }>(`/flags/${id}`, { status }),
};
