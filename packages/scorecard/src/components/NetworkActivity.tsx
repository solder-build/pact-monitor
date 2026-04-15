import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useAnalytics } from "../hooks/useAnalytics";
import { useChartColors } from "../hooks/useChartColors";

function formatUsd(microUnits: number): string {
  return `$${(microUnits / 1_000_000).toFixed(2)}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

const TRIGGER_LABELS: Record<string, string> = {
  timeout: "Timeout",
  error: "HTTP Error",
  schema_mismatch: "Schema Violation",
  latency_sla: "Latency SLA",
};

export function NetworkActivity() {
  const { summary, timeseries, loading, error } = useAnalytics();
  const colors = useChartColors();

  if (loading) {
    return <p className="text-secondary font-mono text-sm">Loading network activity...</p>;
  }

  if (error || !summary) {
    return null;
  }

  const chartData = (timeseries?.data ?? []).map((d) => ({
    label: new Date(d.bucket).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    requests: d.requests,
    claims: d.claims,
  }));

  return (
    <div className="mb-8 border-b border-border pb-8">
      <h2 className="font-serif text-lg text-heading mb-4">Network Activity</h2>

      <div className="grid grid-cols-3 gap-6 mb-6">
        <div>
          <p className="text-xs text-secondary uppercase tracking-widest font-sans mb-1">
            SDK Requests
          </p>
          <p className="text-2xl font-mono text-primary">
            {formatNumber(summary.total_sdk_requests)}
          </p>
        </div>
        <div>
          <p className="text-xs text-secondary uppercase tracking-widest font-sans mb-1">
            Claims Triggered
          </p>
          <p className="text-2xl font-mono text-copper">
            {formatNumber(summary.total_claims)}
          </p>
        </div>
        <div>
          <p className="text-xs text-secondary uppercase tracking-widest font-sans mb-1">
            Refund Amount
          </p>
          <p className="text-2xl font-mono text-copper">
            {formatUsd(summary.total_refund_amount)}
          </p>
        </div>
      </div>

      {Object.keys(summary.claims_by_trigger).length > 0 && (
        <div className="mb-6">
          <p className="text-xs text-secondary uppercase tracking-widest font-sans mb-2">
            Claims by Trigger
          </p>
          <div className="flex gap-4 font-mono text-sm">
            {Object.entries(summary.claims_by_trigger).map(([trigger, count]) => (
              <span key={trigger} className="text-data">
                <span className="text-sienna">{count}</span>
                {" "}
                {TRIGGER_LABELS[trigger] ?? trigger}
              </span>
            ))}
          </div>
        </div>
      )}

      {chartData.length > 0 && (
        <div>
          <p className="text-xs text-secondary uppercase tracking-widest font-sans mb-2">
            7-Day Activity
          </p>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData}>
              <XAxis
                dataKey="label"
                tick={{ fill: colors.axisTick, fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fill: colors.axisTick, fontSize: 10 }} />
              <Tooltip
                contentStyle={{
                  background: colors.tooltipBg,
                  border: `1px solid ${colors.tooltipBorder}`,
                  color: colors.tooltipText,
                  fontFamily: "JetBrains Mono",
                  fontSize: 12,
                }}
              />
              <Bar dataKey="requests" fill="#5A6B7A" name="Requests" />
              <Bar dataKey="claims" fill="#B87333" name="Claims" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
