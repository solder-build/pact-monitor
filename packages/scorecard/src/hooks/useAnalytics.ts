import { useState, useEffect, useCallback } from "react";
import { api, type AnalyticsSummary, type AnalyticsTimeseries } from "../api/client";

export function useAnalytics(refreshIntervalMs = 30_000) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [timeseries, setTimeseries] = useState<AnalyticsTimeseries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [summaryData, timeseriesData] = await Promise.all([
        api.getAnalyticsSummary(),
        api.getAnalyticsTimeseries("daily", 7),
      ]);
      setSummary(summaryData);
      setTimeseries(timeseriesData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch analytics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(timer);
  }, [refresh, refreshIntervalMs]);

  return { summary, timeseries, loading, error };
}
