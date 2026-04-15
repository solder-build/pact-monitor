import { useEffect, useState } from "react";
import { usePhantom } from "../hooks/usePhantom";
import {
  getFaucetStatus,
  requestDrip,
  type FaucetStatus,
  type FaucetDripResponse,
} from "../api/faucet";

type DripState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: FaucetDripResponse }
  | { kind: "error"; message: string; retryAfterSec?: number };

function truncatePubkey(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

function formatRetry(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function FaucetPage() {
  const { pubkey, connecting, error: phantomError, connect, disconnect } = usePhantom();
  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [amount, setAmount] = useState<number>(1000);
  const [drip, setDrip] = useState<DripState>({ kind: "idle" });
  const [countdown, setCountdown] = useState<number>(0);

  // Fetch status on mount. No interval refetch — network detection is fixed
  // per deploy and the max-per-drip value doesn't change at runtime.
  useEffect(() => {
    let cancelled = false;
    getFaucetStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setAmount(Math.min(1000, s.maxPerDrip));
      })
      .catch((err) => {
        if (cancelled) return;
        setStatusErr((err as Error).message || "Failed to load faucet status");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Drive the retry countdown on 429 responses so the button stays disabled
  // until the user is actually allowed to try again.
  useEffect(() => {
    if (countdown <= 0) return;
    const id = window.setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [countdown]);

  async function onClaim() {
    if (!pubkey) return;
    if (!status?.enabled) return;
    if (drip.kind === "submitting") return;

    setDrip({ kind: "submitting" });
    const result = await requestDrip({ recipient: pubkey, amount });
    if (result.ok) {
      setDrip({ kind: "success", result: result.data });
      // After a successful drip, seed the countdown with the 10-minute
      // per-recipient limit so the button disables immediately.
      setCountdown(10 * 60);
      return;
    }

    if (result.status === 429 && result.retryAfterSec !== undefined) {
      setCountdown(result.retryAfterSec);
    }

    setDrip({
      kind: "error",
      message:
        result.error.message ??
        result.error.error ??
        `Request failed with status ${result.status}`,
      retryAfterSec: result.retryAfterSec,
    });
  }

  const canClaim =
    !!pubkey &&
    !!status?.enabled &&
    drip.kind !== "submitting" &&
    countdown === 0 &&
    amount >= (status?.minPerDrip ?? 1) &&
    amount <= (status?.maxPerDrip ?? 10_000);

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8 text-center">
        <h2 className="font-serif text-2xl text-primary mb-2">TEST-USDC Faucet</h2>
        <p className="text-sm text-secondary font-sans">
          Get devnet TEST-USDC so you can try the scorecard as a caller or sponsor.
          Rate-limited to 1 drip per wallet every 10 minutes.
        </p>
      </div>

      {statusErr && (
        <div className="border border-border p-4 mb-6">
          <p className="text-sienna font-mono text-sm">Status error: {statusErr}</p>
        </div>
      )}

      {!status && !statusErr && (
        <p className="text-muted font-mono text-sm">Loading faucet status…</p>
      )}

      {status && !status.enabled && (
        <div className="border border-sienna p-4 mb-6">
          <p className="text-sienna font-mono text-xs uppercase tracking-widest mb-2">
            Disabled — {status.network}
          </p>
          <p className="text-secondary font-mono text-sm">
            {status.reason ?? "Faucet is not available on this network."}
          </p>
        </div>
      )}

      {status && status.enabled && (
        <>
          {/* Network + mint */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="border border-border p-4">
              <p className="text-xs text-muted uppercase tracking-widest font-mono">Network</p>
              <p className="text-base text-primary font-mono mt-1">{status.network}</p>
            </div>
            <div className="border border-border p-4">
              <p className="text-xs text-muted uppercase tracking-widest font-mono">TEST-USDC Mint</p>
              <p className="text-xs text-primary font-mono mt-1 break-all">
                {truncatePubkey(status.mint)}
              </p>
            </div>
          </div>

          {/* Wallet */}
          <div className="border border-border p-4 mb-6">
            <p className="text-xs text-muted uppercase tracking-widest font-mono mb-3">
              Wallet
            </p>
            {pubkey ? (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-primary font-mono break-all">{pubkey}</p>
                <button
                  type="button"
                  onClick={disconnect}
                  className="text-xs font-mono uppercase tracking-widest text-muted hover:text-primary border border-border px-3 py-2"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <div>
                <button
                  type="button"
                  onClick={connect}
                  disabled={connecting}
                  className="bg-copper text-bg font-mono uppercase tracking-widest text-xs px-4 py-3 disabled:opacity-50"
                >
                  {connecting ? "Connecting…" : "Connect Phantom"}
                </button>
                {phantomError && (
                  <p className="text-sienna font-mono text-xs mt-3">{phantomError}</p>
                )}
              </div>
            )}
          </div>

          {/* Amount + claim */}
          <div className="border border-border p-4 mb-6">
            <label className="block text-xs text-muted uppercase tracking-widest font-mono mb-2">
              Amount (whole TEST-USDC, 1 – {status.maxPerDrip.toLocaleString()})
            </label>
            <div className="flex gap-2 mb-4">
              <input
                type="number"
                min={status.minPerDrip}
                max={status.maxPerDrip}
                step={1}
                value={amount}
                onChange={(e) => setAmount(parseInt(e.target.value || "0", 10))}
                className="bg-bg border border-border text-primary font-mono px-3 py-2 w-40"
              />
              <button
                type="button"
                onClick={() => setAmount(status.maxPerDrip)}
                className="text-xs font-mono uppercase tracking-widest text-muted hover:text-primary border border-border px-3 py-2"
              >
                Max
              </button>
            </div>

            <button
              type="button"
              onClick={onClaim}
              disabled={!canClaim}
              className="bg-copper text-bg font-mono uppercase tracking-widest text-xs px-4 py-3 disabled:opacity-30"
            >
              {drip.kind === "submitting"
                ? "Minting…"
                : countdown > 0
                  ? `Next drip in ${formatRetry(countdown)}`
                  : `Claim ${amount.toLocaleString()} TEST-USDC`}
            </button>

            {!pubkey && (
              <p className="text-xs text-muted font-mono mt-3">
                Connect a Phantom wallet to claim.
              </p>
            )}
          </div>

          {/* Drip state feedback */}
          {drip.kind === "success" && (
            <div className="border border-border p-4 mb-6">
              <p className="text-xs text-muted uppercase tracking-widest font-mono mb-2">
                Drip confirmed
              </p>
              <p className="text-primary font-mono text-sm mb-3">
                Minted {drip.result.amount.toLocaleString()} TEST-USDC to{" "}
                {truncatePubkey(drip.result.recipient)}.
              </p>
              <a
                href={drip.result.explorer}
                target="_blank"
                rel="noreferrer"
                className="text-copper font-mono text-xs uppercase tracking-widest underline"
              >
                View on Solana Explorer
              </a>
            </div>
          )}

          {drip.kind === "error" && (
            <div className="border border-sienna p-4 mb-6">
              <p className="text-sienna font-mono text-xs uppercase tracking-widest mb-2">
                Drip failed
              </p>
              <p className="text-secondary font-mono text-sm">{drip.message}</p>
            </div>
          )}
        </>
      )}

      <div className="border border-border p-4">
        <p className="text-xs text-muted uppercase tracking-widest font-mono mb-2">
          Next steps
        </p>
        <ul className="text-sm text-secondary font-sans space-y-2">
          <li>
            • Want to call insured APIs as an agent? See{" "}
            <code className="font-mono text-copper">docs/caller-quickstart.md</code>.
          </li>
          <li>
            • Want to sponsor a pool and earn premiums? See{" "}
            <code className="font-mono text-copper">docs/sponsor-quickstart.md</code>.
          </li>
        </ul>
      </div>
    </div>
  );
}
