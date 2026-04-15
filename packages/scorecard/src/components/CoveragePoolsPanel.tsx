import { useNavigate } from "react-router-dom";
import { usePools } from "../hooks/usePools";
import type { PoolSummary } from "../api/client";

function formatUsdc(amount: string): string {
  return `${(Number(amount) / 1e6).toFixed(2)} USDC`;
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function utilizationPct(pool: PoolSummary): number {
  const deposited = Number(pool.totalDeposited);
  const paid = Number(pool.totalClaimsPaid);
  if (deposited <= 0) return 0;
  return (paid / deposited) * 100;
}

function tierForUtilization(util: number): {
  label: string;
  className: string;
} {
  if (util < 30) {
    return { label: "RELIABLE", className: "text-slate border-slate" };
  }
  if (util < 60) {
    return { label: "WARNING", className: "text-copper border-copper" };
  }
  return { label: "HIGH RISK", className: "text-sienna border-sienna" };
}

export function CoveragePoolsPanel() {
  const { pools, error } = usePools();
  const navigate = useNavigate();

  if (error) {
    return (
      <div className="mb-8">
        <h2 className="font-serif text-lg text-heading mb-4">Coverage Pools</h2>
        <p className="text-sienna font-mono text-sm">Error: {error}</p>
      </div>
    );
  }

  if (pools === null) {
    return (
      <div className="mb-8">
        <h2 className="font-serif text-lg text-heading mb-4">Coverage Pools</h2>
        <p className="text-secondary font-mono text-sm">
          Loading coverage pools...
        </p>
      </div>
    );
  }

  if (pools.length === 0) {
    return (
      <div className="mb-8">
        <h2 className="font-serif text-lg text-heading mb-4">Coverage Pools</h2>
        <p className="text-secondary font-mono text-sm">
          No coverage pools yet
        </p>
      </div>
    );
  }

  return (
    <div className="mb-8">
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-serif text-lg text-heading">Coverage Pools</h2>
        <span className="text-xs text-muted font-mono">
          {pools.length} pool{pools.length === 1 ? "" : "s"}
        </span>
      </div>

      <table className="w-full border-collapse font-mono text-sm">
        <thead>
          <tr className="border-b border-border text-secondary text-xs uppercase tracking-widest">
            <th className="text-left py-3 px-2">Provider</th>
            <th className="text-right py-3 px-2 text-copper">Pool Capital</th>
            <th className="text-right py-3 px-2">Utilization</th>
            <th className="text-right py-3 px-2">Active Policies</th>
            <th className="text-right py-3 px-2 text-copper">Rate</th>
            <th className="text-left py-3 px-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {pools.map((pool) => {
            const util = utilizationPct(pool);
            const tier = tierForUtilization(util);
            return (
              <tr
                key={pool.pda}
                onClick={() => navigate(`/pool/${encodeURIComponent(pool.hostname)}`)}
                className="border-b border-border/50 cursor-pointer hover:bg-surface-light transition-colors"
              >
                <td className="py-3 px-2 text-primary font-sans font-bold">
                  {pool.hostname}
                </td>
                <td className="py-3 px-2 text-right text-copper font-bold">
                  {formatUsdc(pool.totalDeposited)}
                </td>
                <td className="py-3 px-2 text-right text-data">
                  {util.toFixed(2)}%
                </td>
                <td className="py-3 px-2 text-right text-data">
                  {pool.activePolicies.toLocaleString()}
                </td>
                <td className="py-3 px-2 text-right text-copper font-bold">
                  {formatBps(pool.insuranceRateBps)}
                </td>
                <td className="py-3 px-2">
                  <span
                    className={`border px-2 py-0.5 text-xs uppercase tracking-widest ${tier.className}`}
                  >
                    {tier.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
