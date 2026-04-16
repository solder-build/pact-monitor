import { Link } from "react-router-dom";

export function AgentGuide() {
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
        Agent Quickstart
      </h2>
      <p className="text-sm text-secondary font-sans mb-6">
        Insure your AI agent API calls on Pact Network's devnet. Get test USDC,
        enable a policy, call an API through the SDK, and watch a claim settle
        on-chain when the call fails.
      </p>
      <p className="text-xs text-muted font-mono mb-8">
        Estimated time: 10 minutes &middot; Cost: zero (devnet)
      </p>

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
            </Link>{" "}
            &mdash; make sure your Phantom wallet is on <strong>Devnet</strong>{" "}
            (Settings &rarr; Developer Settings &rarr; Testnet Mode: on).
          </li>
          <li>
            Enter an amount (default 1,000) and click{" "}
            <strong>Claim TEST-USDC</strong>.
          </li>
          <li>
            You should see a transaction signature and an Explorer link within
            ~2 seconds.
          </li>
        </ol>
        <p className="text-xs text-muted font-sans mt-3">
          Rate limit: 1 drip per wallet per 10 minutes, max 10,000 TEST-USDC
          per request.
        </p>
        <p className="text-sm text-secondary font-sans mt-3">
          You'll also need a small amount of <strong>devnet SOL</strong> for
          transaction rent. Run{" "}
          <code className="font-mono text-copper">solana airdrop 1</code> or
          use{" "}
          <a
            href="https://faucet.solana.com"
            target="_blank"
            rel="noreferrer"
            className="text-copper font-mono text-xs uppercase tracking-widest"
          >
            faucet.solana.com
          </a>
          .
        </p>
      </section>

      {/* Step 2 */}
      <section className="border border-border p-6 mb-4">
        <h3 className="font-serif text-lg text-heading mb-3">
          2. Enable insurance on a pool
        </h3>
        <p className="text-sm text-secondary font-sans mb-3">
          Every API provider on the scorecard has an on-chain{" "}
          <strong>pool</strong> keyed by hostname (e.g.{" "}
          <code className="font-mono text-copper">api.coingecko.com</code>). To
          insure your calls, you create a <strong>policy</strong> &mdash; a PDA
          derived from (pool, your wallet) &mdash; and pre-fund it with
          TEST-USDC.
        </p>
        <p className="text-sm text-secondary font-sans mb-3">
          The protocol deducts premiums from your balance as you make calls, and
          pays out refunds from the pool vault when calls fail.
        </p>
        <p className="text-sm text-secondary font-sans">
          The easiest way to see this end-to-end is the bundled demo:
        </p>
        <pre className="bg-surface-light border border-border p-4 mt-3 text-xs font-mono text-primary overflow-x-auto">
{`cd samples/demo
pnpm install
pnpm tsx insured-agent.ts api.coingecko.com 5`}
        </pre>
        <p className="text-sm text-secondary font-sans mt-3">
          The script loads a demo agent keypair, funds it, enables insurance on
          the target pool, runs 5 successful calls, then triggers a deliberate
          failure to demonstrate automatic claim settlement.
        </p>
      </section>

      {/* Step 3 */}
      <section className="border border-border p-6 mb-4">
        <h3 className="font-serif text-lg text-heading mb-3">
          3. Use the SDK in your own code
        </h3>
        <pre className="bg-surface-light border border-border p-4 text-xs font-mono text-primary overflow-x-auto">
{`import { pactMonitor } from "@pact-network/monitor";

const pact = pactMonitor({
  apiKey: process.env.PACT_API_KEY!,
  backendUrl: "https://pactnetwork.io",
  agentPubkey: myAgentKeypair.publicKey.toBase58(),
});

const res = await pact.fetch(
  "https://api.coingecko.com/api/v3/ping",
  {
    expectedSchema: { type: "object", required: ["gecko_says"] },
    latencyThresholdMs: 3_000,
  }
);`}
        </pre>
        <p className="text-sm text-secondary font-sans mt-3">
          Every <code className="font-mono text-copper">pact.fetch</code> call
          is classified into{" "}
          <code className="font-mono text-copper">
            success | timeout | error | schema_mismatch
          </code>{" "}
          and flushed to the backend. Failures trigger on-chain claims &mdash;
          the refund lands in your wallet's USDC ATA once the oracle confirms.
        </p>
        <div className="border border-border p-4 mt-4">
          <p className="text-xs text-muted uppercase tracking-widest font-mono mb-2">
            How to get a PACT_API_KEY
          </p>
          <pre className="text-xs font-mono text-primary overflow-x-auto">
{`pnpm --filter @pact-network/backend \\
  run generate-key my-agent --agent-pubkey <your-pubkey>`}
          </pre>
          <p className="text-xs text-muted font-sans mt-2">
            Keys are hashed in the api_keys table &mdash; printed once at
            creation, never stored in plaintext.
          </p>
        </div>
      </section>

      {/* Step 4 */}
      <section className="border border-border p-6 mb-4">
        <h3 className="font-serif text-lg text-heading mb-3">
          4. Verify claims on the scorecard
        </h3>
        <p className="text-sm text-secondary font-sans mb-3">
          After a failed call, open a provider detail page and scroll to the
          recent claims panel. Your claim appears within a few seconds, tagged
          with the trigger type (timeout, error, schema_mismatch, latency_sla).
        </p>
        <p className="text-sm text-secondary font-sans">
          You can also query the API directly:
        </p>
        <pre className="bg-surface-light border border-border p-4 mt-3 text-xs font-mono text-primary overflow-x-auto">
{`curl https://pactnetwork.io/api/v1/claims?agent_pubkey=<your-pubkey>`}
        </pre>
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
              <td className="py-2 pr-4">"Faucet disabled" banner</td>
              <td className="py-2 pr-4">Backend on mainnet or missing keypair</td>
              <td className="py-2">Point backend at devnet; set FAUCET_KEYPAIR_BASE58</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4">enable_insurance InsufficientFunds</td>
              <td className="py-2 pr-4">Wallet below min_pool_deposit</td>
              <td className="py-2">Claim more from the faucet (max 10k)</td>
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-2 pr-4">Claim row never appears</td>
              <td className="py-2 pr-4">Missing agent_pubkey in SDK config</td>
              <td className="py-2">Pass agentPubkey in pactMonitor() config</td>
            </tr>
            <tr>
              <td className="py-2 pr-4">429 on faucet drip</td>
              <td className="py-2 pr-4">Rate limited (1/10min per wallet)</td>
              <td className="py-2">Wait for countdown</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
