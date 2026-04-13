import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api, type ProviderDetail as ProviderDetailType, type TimeseriesData } from "../api/client";
import { FailureTimeline } from "./Charts/FailureTimeline";
import { FailureBreakdown } from "./Charts/FailureBreakdown";
import { usePools } from "../hooks/usePools";

const tierColor: Record<string, string> = {
  RELIABLE: "text-slate border-slate",
  ELEVATED: "text-copper border-copper",
  HIGH_RISK: "text-sienna border-sienna",
};

function formatUsd(lamports: number): string {
  return `$${(lamports / 1_000_000).toFixed(2)}`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface border border-border p-4">
      <div className="text-xs text-secondary uppercase tracking-widest font-sans">{label}</div>
      <div className={`font-mono text-lg mt-1 ${color || "text-primary"}`}>{value}</div>
    </div>
  );
}

function formatUsdcAmount(amount: string): string {
  return `${(Number(amount) / 1e6).toFixed(2)} USDC`;
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function ProviderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [provider, setProvider] = useState<ProviderDetailType | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesData | null>(null);
  const [loading, setLoading] = useState(true);
  const { pools } = usePools();

  useEffect(() => {
    if (!id) return;
    Promise.all([api.getProvider(id), api.getTimeseries(id)])
      .then(([p, ts]) => {
        setProvider(p);
        setTimeseries(ts);
      })
      .finally(() => setLoading(false));
  }, [id]);

  const matchedPool = useMemo(() => {
    if (!provider || !pools) return null;
    const hostname = (provider as { hostname?: string; base_url?: string }).hostname
      ?? (provider as { hostname?: string; base_url?: string }).base_url;
    if (!hostname) return null;
    return pools.find((pool) => pool.hostname === hostname) || null;
  }, [provider, pools]);

  if (loading) return <p className="text-secondary font-mono text-sm">Loading...</p>;
  if (!provider) return <p className="text-sienna font-mono text-sm">Provider not found</p>;

  return (
    <div>
      <button
        onClick={() => navigate("/")}
        className="text-sm text-secondary hover:text-heading font-sans mb-4 border border-border px-3 py-1"
      >
        Back to rankings
      </button>

      <div className="mb-6">
        <h2 className="font-serif text-2xl text-primary">{provider.name}</h2>
        <p className="text-sm text-secondary font-sans">{provider.category}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
        <StatCard label="Failure Rate" value={formatPct(provider.failure_rate)} color="text-copper" />
        <StatCard label="Avg Latency" value={`${provider.avg_latency_ms}ms`} />
        <StatCard label="Insurance Rate" value={formatPct(provider.insurance_rate)} color="text-copper" />
        <StatCard label="$ Lost" value={formatUsd(provider.lost_payment_amount)} color="text-sienna" />
        <div className="bg-surface border border-border p-4">
          <div className="text-xs text-secondary uppercase tracking-widest font-sans">Tier</div>
          <span className={`border px-2 py-0.5 text-sm uppercase tracking-widest font-mono mt-1 inline-block ${tierColor[provider.tier] || ""}`}>
            {provider.tier.replace("_", " ")}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="bg-surface border border-border p-4">
          <h3 className="text-xs text-secondary uppercase tracking-widest font-sans mb-4">Failure Rate Over Time</h3>
          {timeseries && <FailureTimeline data={timeseries.data} />}
        </div>
        <div className="bg-surface border border-border p-4">
          <h3 className="text-xs text-secondary uppercase tracking-widest font-sans mb-4">Failure Breakdown</h3>
          <FailureBreakdown breakdown={provider.failure_breakdown} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-surface border border-border p-4">
          <h3 className="text-xs text-secondary uppercase tracking-widest font-sans mb-4">Top Endpoints</h3>
          <table className="w-full font-mono text-sm">
            <thead>
              <tr className="text-secondary text-xs border-b border-border">
                <th className="text-left py-2">Endpoint</th>
                <th className="text-right py-2">Calls</th>
                <th className="text-right py-2">Failure</th>
              </tr>
            </thead>
            <tbody>
              {provider.top_endpoints.map((ep) => (
                <tr key={ep.endpoint} className="border-b border-border/50">
                  <td className="py-2 text-heading">{ep.endpoint}</td>
                  <td className="py-2 text-right text-data">{ep.calls.toLocaleString()}</td>
                  <td className="py-2 text-right text-copper">{formatPct(ep.failure_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-surface border border-border p-4">
          <h3 className="text-xs text-secondary uppercase tracking-widest font-sans mb-4">Payment Protocols</h3>
          <table className="w-full font-mono text-sm">
            <thead>
              <tr className="text-secondary text-xs border-b border-border">
                <th className="text-left py-2">Protocol</th>
                <th className="text-right py-2">Calls</th>
                <th className="text-right py-2">Total</th>
                <th className="text-right py-2">Lost</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(provider.payment_breakdown).map(([proto, data]) => (
                <tr key={proto} className="border-b border-border/50">
                  <td className="py-2 text-heading">{proto}</td>
                  <td className="py-2 text-right text-data">{data.calls.toLocaleString()}</td>
                  <td className="py-2 text-right text-data">{formatUsd(data.total_amount)}</td>
                  <td className="py-2 text-right text-sienna">{formatUsd(data.lost_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-surface border border-border p-4 mt-6">
        <h3 className="text-xs text-secondary uppercase tracking-widest font-sans mb-4">Coverage</h3>
        {matchedPool ? (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
              <div>
                <div className="text-xs text-secondary uppercase tracking-widest font-sans">Pool Capital</div>
                <div className="font-mono text-lg mt-1 text-copper">
                  {formatUsdcAmount(matchedPool.totalDeposited)}
                </div>
              </div>
              <div>
                <div className="text-xs text-secondary uppercase tracking-widest font-sans">Current Rate</div>
                <div className="font-mono text-lg mt-1 text-copper">
                  {formatBps(matchedPool.insuranceRateBps)}
                </div>
              </div>
              <div>
                <div className="text-xs text-secondary uppercase tracking-widest font-sans">Active Policies</div>
                <div className="font-mono text-lg mt-1 text-primary">
                  {matchedPool.activePolicies.toLocaleString()}
                </div>
              </div>
            </div>
            <Link
              to={`/pool/${encodeURIComponent(matchedPool.hostname)}`}
              className="inline-block text-sm text-copper hover:text-heading font-sans border border-copper px-3 py-1"
            >
              View Pool Details
            </Link>
          </div>
        ) : (
          <p className="text-secondary font-mono text-sm">No coverage pool for this provider</p>
        )}
      </div>
    </div>
  );
}
