import { useParams, useNavigate } from "react-router-dom";
import { usePool } from "../hooks/usePool";
import type { PoolClaimInfo, PoolPositionInfo } from "../api/client";

function formatUsdc(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined) return "0.00 USDC";
  return `${(Number(amount) / 1e6).toFixed(2)} USDC`;
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function truncatePubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`;
}

function formatUnixTimestamp(ts: string): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n * 1000).toLocaleString();
}

function formatIsoTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="bg-surface border border-border p-4">
      <div className="text-xs text-secondary uppercase tracking-widest font-sans">
        {label}
      </div>
      <div className={`font-mono text-lg mt-1 ${color || "text-primary"}`}>
        {value}
      </div>
    </div>
  );
}

function explorerAddressUrl(pubkey: string): string {
  return `https://explorer.solana.com/address/${pubkey}?cluster=devnet`;
}

function explorerTxUrl(tx: string): string {
  return `https://explorer.solana.com/tx/${tx}?cluster=devnet`;
}

export function PoolDetail() {
  const { hostname } = useParams<{ hostname: string }>();
  const navigate = useNavigate();
  const { pool, error, loading } = usePool(hostname);

  if (loading && !pool) {
    return (
      <p className="text-secondary font-mono text-sm">Loading pool...</p>
    );
  }

  if (error) {
    return (
      <div>
        <button
          onClick={() => navigate("/")}
          className="text-sm text-secondary hover:text-heading font-sans mb-4 border border-border px-3 py-1"
        >
          Back to rankings
        </button>
        <p className="text-sienna font-mono text-sm">Error: {error}</p>
      </div>
    );
  }

  if (!pool) {
    return (
      <div>
        <button
          onClick={() => navigate("/")}
          className="text-sm text-secondary hover:text-heading font-sans mb-4 border border-border px-3 py-1"
        >
          Back to rankings
        </button>
        <p className="text-sienna font-mono text-sm">Pool not found</p>
      </div>
    );
  }

  const { pool: poolInfo, positions, recentClaims } = pool;

  return (
    <div>
      <button
        onClick={() => navigate("/")}
        className="text-sm text-secondary hover:text-heading font-sans mb-4 border border-border px-3 py-1"
      >
        Back to rankings
      </button>

      <div className="mb-6">
        <h2 className="font-serif text-2xl text-primary">
          {poolInfo.hostname}
        </h2>
        <p className="text-sm text-secondary font-sans">Coverage Pool</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        <StatCard
          label="Pool Capital"
          value={formatUsdc(poolInfo.totalDeposited)}
          color="text-copper"
        />
        <StatCard
          label="Total Available"
          value={formatUsdc(poolInfo.totalAvailable)}
          color="text-copper"
        />
        <StatCard
          label="Premiums Earned"
          value={formatUsdc(poolInfo.totalPremiumsEarned)}
          color="text-slate"
        />
        <StatCard
          label="Claims Paid"
          value={formatUsdc(poolInfo.totalClaimsPaid)}
          color="text-sienna"
        />
        <StatCard
          label="Active Policies"
          value={poolInfo.activePolicies.toLocaleString()}
        />
        <StatCard
          label="Current Rate"
          value={formatBps(poolInfo.insuranceRateBps)}
          color="text-copper"
        />
      </div>

      <div className="bg-surface border border-border p-4 mb-8">
        <h3 className="text-xs text-secondary uppercase tracking-widest font-sans mb-4">
          Underwriter Positions
        </h3>
        {positions.length === 0 ? (
          <p className="text-secondary font-mono text-sm">
            No underwriter positions yet
          </p>
        ) : (
          <table className="w-full font-mono text-sm">
            <thead>
              <tr className="text-secondary text-xs border-b border-border uppercase tracking-widest">
                <th className="text-left py-2">Underwriter</th>
                <th className="text-right py-2">Deposited</th>
                <th className="text-right py-2">Earned Premiums</th>
                <th className="text-right py-2">Deposit Time</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos: PoolPositionInfo) => (
                <tr key={pos.underwriter} className="border-b border-border/50">
                  <td className="py-2">
                    <a
                      href={explorerAddressUrl(pos.underwriter)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-heading hover:text-copper underline decoration-dotted"
                    >
                      {truncatePubkey(pos.underwriter)}
                    </a>
                  </td>
                  <td className="py-2 text-right text-copper">
                    {formatUsdc(pos.deposited)}
                  </td>
                  <td className="py-2 text-right text-slate">
                    {formatUsdc(pos.earnedPremiums)}
                  </td>
                  <td className="py-2 text-right text-data">
                    {formatUnixTimestamp(pos.depositTimestamp)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-surface border border-border p-4">
        <h3 className="text-xs text-secondary uppercase tracking-widest font-sans mb-4">
          Recent Claims
        </h3>
        {recentClaims.length === 0 ? (
          <p className="text-secondary font-mono text-sm">
            No claims settled yet
          </p>
        ) : (
          <table className="w-full font-mono text-sm">
            <thead>
              <tr className="text-secondary text-xs border-b border-border uppercase tracking-widest">
                <th className="text-left py-2">Agent</th>
                <th className="text-left py-2">Trigger</th>
                <th className="text-right py-2">Refund</th>
                <th className="text-right py-2">Settled</th>
                <th className="text-right py-2">Tx</th>
              </tr>
            </thead>
            <tbody>
              {recentClaims.map((claim: PoolClaimInfo) => (
                <tr key={claim.id} className="border-b border-border/50">
                  <td className="py-2 text-heading">
                    {claim.agent_id || "-"}
                  </td>
                  <td className="py-2 text-secondary uppercase text-xs tracking-widest">
                    {claim.trigger_type}
                  </td>
                  <td className="py-2 text-right text-copper">
                    {formatUsdc(claim.refund_amount)}
                  </td>
                  <td className="py-2 text-right text-data">
                    {formatIsoTimestamp(claim.created_at)}
                  </td>
                  <td className="py-2 text-right">
                    {claim.tx_hash ? (
                      <a
                        href={explorerTxUrl(claim.tx_hash)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-copper hover:text-heading underline decoration-dotted"
                      >
                        {truncatePubkey(claim.tx_hash)}
                      </a>
                    ) : (
                      <span className="text-secondary">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
