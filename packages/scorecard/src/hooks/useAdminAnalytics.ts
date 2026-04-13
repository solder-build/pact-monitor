import { useState, useEffect, useCallback } from "react";
import {
  adminApi,
  type OverviewData,
  type RouteHealth,
  type IngestionPoint,
  type AgentsData,
  type ScorecardUsageData,
  type CostRow,
} from "../api/admin-client";

export interface AdminAnalytics {
  overview: OverviewData | null;
  backendHealth: RouteHealth[];
  ingestion: IngestionPoint[];
  agents: AgentsData | null;
  scorecardUsage: ScorecardUsageData | null;
  costs: CostRow[];
  loading: boolean;
  error: string | null;
}

export function useAdminAnalytics(refreshIntervalMs = 60_000): AdminAnalytics {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [backendHealth, setBackendHealth] = useState<RouteHealth[]>([]);
  const [ingestion, setIngestion] = useState<IngestionPoint[]>([]);
  const [agents, setAgents] = useState<AgentsData | null>(null);
  const [scorecardUsage, setScorecardUsage] = useState<ScorecardUsageData | null>(null);
  const [costs, setCosts] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [ov, bh, ig, ag, su, co] = await Promise.all([
        adminApi.getOverview(),
        adminApi.getBackendHealth(),
        adminApi.getIngestion(),
        adminApi.getAgents(),
        adminApi.getScorecardUsage(),
        adminApi.getCosts(),
      ]);
      setOverview(ov);
      setBackendHealth(bh);
      setIngestion(ig);
      setAgents(ag);
      setScorecardUsage(su);
      setCosts(co);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch admin data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(timer);
  }, [refresh, refreshIntervalMs]);

  return { overview, backendHealth, ingestion, agents, scorecardUsage, costs, loading, error };
}
