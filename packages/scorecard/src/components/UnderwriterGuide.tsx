import { Link } from "react-router-dom";

export function UnderwriterGuide() {
  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-4">
        <Link
          to="/"
          className="text-xs font-mono uppercase tracking-widest text-muted hover:text-primary"
        >
          &larr; Back to rankings
        </Link>
      </div>

      <h2 className="font-serif text-2xl text-primary mb-2">
        Underwriter Quickstart
      </h2>
      <p className="text-sm text-secondary font-sans mb-6">
        Deposit TEST-USDC into a provider pool's vault. The protocol pays out
        refunds when Agents experience failures and collects premiums from every
        successful call, accruing to Underwriters proportionally.
      </p>
      <p className="text-xs text-muted font-mono mb-4">
        Estimated time: 5 minutes &middot; Cost: zero (devnet)
      </p>

      {/* Risk/reward summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="border border-border p-4">
          <p className="text-xs text-muted uppercase tracking-widest font-mono mb-1">Upside</p>
          <p className="text-sm text-secondary font-sans">Premiums from every successful call, pro-rata to your share</p>
        </div>
        <div className="border border-border p-4">
          <p className="text-xs text-muted uppercase tracking-widest font-mono mb-1">Downside</p>
          <p className="text-sm text-secondary font-sans">Vault pays refunds on failures; your share is diluted</p>
        </div>
        <div className="border border-border p-4">
          <p className="text-xs text-muted uppercase tracking-widest font-mono mb-1">Break-even</p>
          <p className="text-sm text-secondary font-sans">Realized failure rate = published insurance rate (bps)</p>
        </div>
        <div className="border border-border p-4">
          <p className="text-xs text-muted uppercase tracking-widest font-mono mb-1">Safety</p>
          <p className="text-sm text-secondary font-sans">Aggregate claims capped at 30% of vault per 24h</p>
        </div>
      </div>

      {/* Step 1 */}
      <section className="border border-border p-6 mb-4">
        <h3 className="font-serif text-lg text-heading mb-3">
          1. Get TEST-USDC from the faucet
        </h3>
        <ol className="text-sm text-secondary font-sans space-y-2 list-decimal list-inside">
          <li>
            Visit the{" "}
            <Link to="/faucet" className="text-copper font-mono text-xs uppercase tracking-widest">
              Faucet
            </Link>
            .
          </li>
          <li>Connect Phantom on <strong>Devnet</strong>.</li>
          <li>
            Claim the maximum (10,000 TEST-USDC) &mdash; the protocol's{" "}
            <code className="font-mono text-copper">min_pool_deposit</code> is
            100 USDC so 10k gives you room to split across pools.
          </li>
        </ol>
        <p className="text-sm text-secondary font-sans mt-3">
          You'll also need a little devnet SOL for rent &mdash;{" "}
          <code className="font-mono text-copper">solana airdrop 1</code>{" "}
          covers it.
        </p>
      </section>

      {/* Step 2 */}
      <section className="border border-border p-6 mb-4">
        <h3 className="font-serif text-lg text-heading mb-3">
          2. Pick a pool
        </h3>
        <p className="text-sm text-secondary font-sans mb-3">
          Browse pools on the{" "}
          <Link to="/" className="text-copper font-mono text-xs uppercase tracking-widest">
            Rankings
          </Link>{" "}
          page. Each provider has a pool detail page showing:
        </p>
        <ul className="text-sm text-secondary font-sans space-y-1 list-disc list-inside mb-3">
          <li>Current vault balance</li>
          <li>Last 24h premiums paid in and claims paid out</li>
          <li>Failure rate (rolling 7 days) and insurance rate (bps)</li>
        </ul>
        <p className="text-sm text-secondary font-sans">
          Pools where premiums paid &gt; claims paid are profitable for
          Underwriters in expectation. If you believe a provider is more reliable
          than the market thinks, underwriting its pool is a directional bet.
        </p>
      </section>

      {/* Step 3 */}
      <section className="border border-border p-6 mb-4">
        <h3 className="font-serif text-lg text-heading mb-3">
          3. Deposit into the pool vault
        </h3>
        <p className="text-sm text-secondary font-sans mb-3">
          The on-chain instruction is{" "}
          <code className="font-mono text-copper">deposit(pool, amount)</code>.
          For devnet, use the seed script:
        </p>
        <pre className="bg-surface-light border border-border p-4 text-xs font-mono text-primary overflow-x-auto">
{`cd packages/program
pnpm tsx scripts/seed-devnet-pools.ts`}
        </pre>
        <p className="text-sm text-secondary font-sans mt-3">
          The script derives the pool PDA from the hostname, signs a deposit
          transaction using your keypair, and prints the new vault balance and
          your pro-rata share.
        </p>
        <p className="text-xs text-muted font-sans mt-2">
          Minimum deposit: 100 TEST-USDC (enforced by config.min_pool_deposit).
        </p>
      </section>

      {/* Step 4 */}
      <section className="border border-border p-6 mb-4">
        <h3 className="font-serif text-lg text-heading mb-3">
          4. Watch premiums accrue
        </h3>
        <p className="text-sm text-secondary font-sans mb-3">
          Every call from an insured Agent on the pool triggers a{" "}
          <code className="font-mono text-copper">settle_premium</code>{" "}
          instruction. The premium flows from the Agent's policy balance into the
          vault. Your pro-rata share grows as the vault grows.
        </p>
        <p className="text-sm text-secondary font-sans">Track it two ways:</p>
        <ul className="text-sm text-secondary font-sans space-y-1 list-disc list-inside mt-2">
          <li>
            <strong>Scorecard pool detail</strong>: "Vault balance" and
            "Premiums (24h)" update as calls come in
          </li>
          <li>
            <strong>On-chain</strong>: fetch the pool account and divide your
            deposit by total vault balance
          </li>
        </ul>
      </section>

      {/* Step 5 */}
      <section className="border border-border p-6 mb-4">
        <h3 className="font-serif text-lg text-heading mb-3">
          5. Withdraw (after cooldown)
        </h3>
        <p className="text-sm text-secondary font-sans mb-3">
          The protocol enforces a <strong>7-day withdrawal cooldown</strong> to
          prevent flash-deposit-claim-withdraw griefs. Once elapsed:
        </p>
        <pre className="bg-surface-light border border-border p-4 text-xs font-mono text-primary overflow-x-auto">
{`pnpm tsx scripts/withdraw-from-pool.ts api.coingecko.com 5000`}
        </pre>
        <p className="text-sm text-secondary font-sans mt-3">
          The instruction moves USDC from the vault back to your wallet ATA,
          subject to the pool's current balance and the aggregate claim cap (30%
          per 24h window).
        </p>
        <p className="text-xs text-muted font-sans mt-2">
          If the vault recently paid a large claim, your withdrawable balance may
          be less than your deposit. That's the risk side of the underwriter bet.
        </p>
      </section>

      {/* Troubleshooting */}
      <section className="border border-border p-6">
        <h3 className="font-serif text-lg text-heading mb-3">
          Troubleshooting
        </h3>
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="border-b border-border text-xs text-muted uppercase tracking-widest">
              <th className="text-left py-2 pr-4">Symptom</th>
              <th className="text-left py-2 pr-4">Cause</th>
              <th className="text-left py-2">Fix</th>
            </tr>
          </thead>
          <tbody className="text-secondary">
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4">deposit InsufficientFunds</td>
              <td className="py-2 pr-4">Wallet below 100 TEST-USDC</td>
              <td className="py-2">Claim from the faucet (max 10k)</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4">withdraw CooldownNotElapsed</td>
              <td className="py-2 pr-4">Less than 7 days since deposit</td>
              <td className="py-2">Wait; check last_deposit_at on pool account</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4">withdraw returns less than deposited</td>
              <td className="py-2 pr-4">Vault paid claims while you were in</td>
              <td className="py-2">Expected; see risk/reward above</td>
            </tr>
            <tr>
              <td className="py-2 pr-4">withdraw AggregateCapExceeded</td>
              <td className="py-2 pr-4">Pool hit 24h claim cap</td>
              <td className="py-2">Wait for rolling window to clear</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
