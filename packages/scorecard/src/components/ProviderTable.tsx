import { useNavigate, Link } from "react-router-dom";
import { useProviders } from "../hooks/useProviders";
import { NetworkActivity } from "./NetworkActivity";
import { CoveragePoolsPanel } from "./CoveragePoolsPanel";
import { track } from "../analytics/tracker";

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

export function ProviderTable() {
  const { providers, loading, error, lastUpdated } = useProviders();
  const navigate = useNavigate();

  if (loading) {
    return <p className="text-secondary font-mono text-sm">Loading providers...</p>;
  }

  if (error) {
    return <p className="text-sienna font-mono text-sm">Error: {error}</p>;
  }

  return (
    <div>
      {/* Getting Started */}
      <div className="border border-border p-6 mb-6">
        <h2 className="font-serif text-lg text-heading mb-3">Getting Started</h2>
        <p className="text-sm text-secondary font-sans mb-4">
          Pact Network is a parametric insurance protocol for AI agent API calls on Solana.
          Three roles participate in the market:
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="border border-border p-4">
            <p className="text-xs text-copper uppercase tracking-widest font-mono mb-2">Agent</p>
            <p className="text-sm text-secondary font-sans">
              Pay a small premium per API call. Receive automatic USDC refunds when the API
              violates SLA thresholds. No claims process.
            </p>
          </div>
          <div className="border border-border p-4">
            <p className="text-xs text-copper uppercase tracking-widest font-mono mb-2">Underwriter</p>
            <p className="text-sm text-secondary font-sans">
              Deposit USDC into coverage pools. Earn yield from premiums when APIs are reliable.
              Absorb losses when APIs fail.
            </p>
          </div>
          <div className="border border-border p-4">
            <p className="text-xs text-copper uppercase tracking-widest font-mono mb-2">API Provider</p>
            <p className="text-sm text-secondary font-sans">
              Don't stake anything. Their insurance rate becomes a public, market-derived quality
              score. Lower rate = more reliable = more agent traffic.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-sm font-sans">
          <Link to="/guide/agent" className="text-copper font-mono text-xs uppercase tracking-widest">
            Agent Quickstart
          </Link>
          <Link to="/guide/underwriter" className="text-copper font-mono text-xs uppercase tracking-widest">
            Underwriter Quickstart
          </Link>
          <Link to="/faucet" className="text-copper font-mono text-xs uppercase tracking-widest">
            Get TEST-USDC
          </Link>
        </div>
      </div>

      <NetworkActivity />
      <CoveragePoolsPanel />
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-serif text-lg text-heading">Provider Rankings</h2>
        {lastUpdated && (
          <span className="text-xs text-muted font-mono">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </div>

      <table className="w-full border-collapse font-mono text-sm">
        <thead>
          <tr className="border-b border-border text-secondary text-xs uppercase tracking-widest">
            <th className="text-left py-3 px-2">Provider</th>
            <th className="text-left py-3 px-2">Category</th>
            <th className="text-right py-3 px-2">Calls</th>
            <th className="text-right py-3 px-2">Failure</th>
            <th className="text-right py-3 px-2">Latency</th>
            <th className="text-right py-3 px-2">Uptime</th>
            <th className="text-right py-3 px-2 text-copper">Ins. Rate</th>
            <th className="text-right py-3 px-2">$ at Risk</th>
            <th className="text-left py-3 px-2">Tier</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr
              key={p.id}
              onClick={() => { track("provider_click", { provider_id: p.id, provider_name: p.name }); navigate(`/provider/${p.id}`); }}
              className="border-b border-border/50 cursor-pointer hover:bg-surface-light transition-colors"
            >
              <td className="py-3 px-2 text-primary font-sans font-bold">{p.name}</td>
              <td className="py-3 px-2 text-secondary">{p.category}</td>
              <td className="py-3 px-2 text-right text-data">{p.total_calls.toLocaleString()}</td>
              <td className="py-3 px-2 text-right text-data">{formatPct(p.failure_rate)}</td>
              <td className="py-3 px-2 text-right text-data">{p.avg_latency_ms}ms</td>
              <td className="py-3 px-2 text-right text-data">{formatPct(p.uptime)}</td>
              <td className="py-3 px-2 text-right text-copper font-bold">{formatPct(p.insurance_rate)}</td>
              <td className="py-3 px-2 text-right text-data">
                {p.lost_payment_amount > 0 ? formatUsd(p.lost_payment_amount) : "-"}
              </td>
              <td className="py-3 px-2">
                <span className={`border px-2 py-0.5 text-xs uppercase tracking-widest ${tierColor[p.tier] || "text-secondary border-secondary"}`}>
                  {p.tier.replace("_", " ")}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
