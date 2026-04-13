import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line } from "recharts";
import { useAdminAnalytics } from "../hooks/useAdminAnalytics";

const tooltipStyle = {
  background: "#1A1917",
  border: "1px solid #333330",
  color: "#ccc",
  fontFamily: "JetBrains Mono",
  fontSize: 12,
};

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="border border-border p-4">
      <p className="text-xs text-neutral-500 uppercase tracking-widest font-mono">{label}</p>
      <p className="text-2xl text-neutral-200 font-mono mt-1">{value}</p>
      {sub && <p className="text-xs text-neutral-500 font-mono mt-1">{sub}</p>}
    </div>
  );
}

function formatUsd(microUsdc: number): string {
  return `$${(microUsdc / 1_000_000).toFixed(2)}`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatTime(bucket: string): string {
  return new Date(bucket).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatDay(day: string): string {
  return new Date(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function AdminDashboard() {
  const { overview, backendHealth, ingestion, agents, scorecardUsage, costs, loading, error } = useAdminAnalytics();

  if (loading) {
    return <p className="text-neutral-500 font-mono text-sm">Loading analytics...</p>;
  }

  if (error) {
    return <p className="text-sienna font-mono text-sm">Error: {error}</p>;
  }

  return (
    <div>
      <h2 className="font-serif text-lg text-neutral-300 mb-6">Admin Analytics</h2>

      {/* Overview cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        <StatCard label="Total Records" value={overview?.total_records.toLocaleString() || "0"} />
        <StatCard label="Providers" value={overview?.total_providers || 0} />
        <StatCard label="Unique Agents" value={overview?.unique_agents || 0} />
        <StatCard label="Payment Volume" value={formatUsd(overview?.total_payment_volume || 0)} />
        <StatCard label="Lost Value" value={formatUsd(overview?.total_lost_value || 0)} />
        <StatCard label="Settlement Rate" value={formatPct(overview?.settlement_rate || 0)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left: Technical */}
        <div>
          <h3 className="font-serif text-base text-neutral-400 mb-4 border-b border-border pb-2">Technical</h3>

          {/* Backend health table */}
          <div className="mb-6">
            <p className="text-xs text-neutral-500 uppercase tracking-widest font-mono mb-2">Backend Route Health (24h)</p>
            <table className="w-full font-mono text-xs">
              <thead>
                <tr className="text-neutral-500 border-b border-border">
                  <th className="text-left py-2">Route</th>
                  <th className="text-right py-2">Reqs</th>
                  <th className="text-right py-2">Err%</th>
                  <th className="text-right py-2">p50</th>
                  <th className="text-right py-2">p95</th>
                  <th className="text-right py-2">p99</th>
                </tr>
              </thead>
              <tbody>
                {backendHealth.map((r) => (
                  <tr key={r.route} className="border-b border-border/30">
                    <td className="py-2 text-neutral-300">{r.route}</td>
                    <td className="py-2 text-right text-neutral-300">{r.requests}</td>
                    <td className={`py-2 text-right ${r.error_rate > 0 ? "text-sienna" : "text-neutral-500"}`}>
                      {formatPct(r.error_rate)}
                    </td>
                    <td className="py-2 text-right text-neutral-400">{Math.round(r.p50_ms)}ms</td>
                    <td className="py-2 text-right text-neutral-400">{Math.round(r.p95_ms)}ms</td>
                    <td className="py-2 text-right text-neutral-400">{Math.round(r.p99_ms)}ms</td>
                  </tr>
                ))}
                {backendHealth.length === 0 && (
                  <tr><td colSpan={6} className="py-2 text-neutral-500">No data yet</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Ingestion rate chart */}
          <div className="mb-6">
            <p className="text-xs text-neutral-500 uppercase tracking-widest font-mono mb-2">Ingestion Rate (24h)</p>
            {ingestion.length > 0 ? (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={ingestion.map((d) => ({ ...d, label: formatTime(d.bucket) }))}>
                  <XAxis dataKey="label" tick={{ fill: "#5A6B7A", fontSize: 9 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fill: "#5A6B7A", fontSize: 9 }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="records" fill="#5A6B7A" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-neutral-500 font-mono text-xs">No ingestion data yet</p>
            )}
          </div>

          {/* Cost breakdown table */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest font-mono mb-2">Cost by Provider</p>
            <table className="w-full font-mono text-xs">
              <thead>
                <tr className="text-neutral-500 border-b border-border">
                  <th className="text-left py-2">Provider</th>
                  <th className="text-right py-2">Calls</th>
                  <th className="text-right py-2">Avg Cost</th>
                  <th className="text-right py-2">Total Paid</th>
                  <th className="text-right py-2 text-sienna">Lost</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.provider} className="border-b border-border/30">
                    <td className="py-2 text-neutral-300">{c.provider}</td>
                    <td className="py-2 text-right text-neutral-300">{c.total_calls.toLocaleString()}</td>
                    <td className="py-2 text-right text-copper">{formatUsd(c.avg_payment_micro_usdc)}</td>
                    <td className="py-2 text-right text-neutral-400">{formatUsd(c.total_paid)}</td>
                    <td className="py-2 text-right text-sienna">{formatUsd(c.total_lost)}</td>
                  </tr>
                ))}
                {costs.length === 0 && (
                  <tr><td colSpan={5} className="py-2 text-neutral-500">No data yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: Product */}
        <div>
          <h3 className="font-serif text-base text-neutral-400 mb-4 border-b border-border pb-2">Product</h3>

          {/* Scorecard usage cards */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <StatCard label="Page Views (24h)" value={scorecardUsage?.total_views || 0} />
            <StatCard label="Unique Sessions" value={scorecardUsage?.unique_sessions || 0} />
            <StatCard label="Provider Clicks" value={scorecardUsage?.provider_clicks || 0} />
            <StatCard
              label="Click-Through Rate"
              value={formatPct(scorecardUsage?.click_through_rate || 0)}
            />
          </div>

          {/* Page views chart */}
          <div className="mb-6">
            <p className="text-xs text-neutral-500 uppercase tracking-widest font-mono mb-2">Scorecard Views (24h)</p>
            {scorecardUsage && scorecardUsage.hourly.length > 0 ? (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={scorecardUsage.hourly.map((d) => ({ ...d, label: formatTime(d.bucket) }))}>
                  <XAxis dataKey="label" tick={{ fill: "#5A6B7A", fontSize: 9 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fill: "#5A6B7A", fontSize: 9 }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="views" fill="#B87333" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-neutral-500 font-mono text-xs">No view data yet</p>
            )}
          </div>

          {/* Agent growth chart */}
          <div className="mb-6">
            <p className="text-xs text-neutral-500 uppercase tracking-widest font-mono mb-2">
              Agent Activity (7d)
              {agents && <span className="ml-2 text-copper">Retention: {formatPct(agents.retention_rate)}</span>}
            </p>
            {agents && agents.daily.length > 0 ? (
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={agents.daily.map((d) => ({ ...d, label: formatDay(d.day) }))}>
                  <XAxis dataKey="label" tick={{ fill: "#5A6B7A", fontSize: 9 }} />
                  <YAxis tick={{ fill: "#5A6B7A", fontSize: 9 }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Line type="monotone" dataKey="active_agents" stroke="#B87333" dot={false} name="Active" />
                  <Line type="monotone" dataKey="new_agents" stroke="#C9553D" dot={false} name="New" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-neutral-500 font-mono text-xs">No agent data yet</p>
            )}
          </div>

          {/* Value summary */}
          {overview && (
            <div className="border border-border p-4">
              <p className="text-xs text-neutral-500 uppercase tracking-widest font-mono mb-2">Value at Risk Summary</p>
              <div className="font-mono text-sm space-y-1">
                <p className="text-neutral-300">
                  Total payment volume: <span className="text-copper">{formatUsd(overview.total_payment_volume)}</span>
                </p>
                <p className="text-neutral-300">
                  Lost to failures: <span className="text-sienna">{formatUsd(overview.total_lost_value)}</span>
                </p>
                <p className="text-neutral-300">
                  Loss rate:{" "}
                  <span className="text-sienna">
                    {overview.total_payment_volume > 0
                      ? formatPct(overview.total_lost_value / overview.total_payment_volume)
                      : "0.0%"}
                  </span>
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
